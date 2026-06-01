import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/dart/element/type.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;

import '../analysis/overlay_session.dart';
import '../conversion_error.dart';
import '../edits.dart';

/// Pass 7 — rewrite every business-side reach into `dart:core` into a call
/// against `package:dart2cpp/restorer/runtime_classes.dart`. Runs **before**
/// Pass 4 (function-value wrapping) so that:
///   * `print(x)` / `print` tear-off → `staticPrint`
///   * `[a, b, c]` literal           → `StaticList<T>.ofN(a, b, c)`
///   * `List<T>` type annotation     → `StaticList<T>`
/// After rewriting, injects the restorer import so Pass 4 can resolve the
/// new identifiers.
///
/// Refuses (with a source location) on patterns the restorer doesn't model:
///   * list literal with `for` / `if` / spread elements
///   * list literal whose element type infers to `dynamic`
///   * list literal in a constant context (arity factories aren't const)
///   * list literal exceeding [_kMaxListLiteralLen] elements
const String _kRestorerImport =
    "import 'package:dart2cpp/restorer/runtime_classes.dart';";
const String _kRestorerUri = 'package:dart2cpp/restorer/runtime_classes.dart';
const String _kDartCoreUri = 'dart:core';
const int _kMaxListLiteralLen = 8;

Future<String> rewriteCoreCalls(OverlaySession session) async {
  final result = await session.resolved();
  final source = session.currentSource();
  final visitor = _CoreRewriter(session.absPath, result.lineInfo);
  result.unit.visitChildren(visitor);
  final rewritten = applyEdits(source, visitor.edits);
  return _ensureRestorerImport(rewritten);
}

String _ensureRestorerImport(String source) {
  if (source.contains(_kRestorerImport)) return source;
  // Only inject when the rewritten source actually references restorer
  // symbols; otherwise the converted file would carry an unused-import
  // warning. The set of public symbols is small enough to enumerate.
  if (!source.contains('staticPrint') && !source.contains('StaticList')) {
    return source;
  }
  final importRegex =
      RegExp("^import\\s+['\"][^'\"]+['\"][^;]*;", multiLine: true);
  final matches = importRegex.allMatches(source).toList();
  if (matches.isEmpty) {
    return '$_kRestorerImport\n\n$source';
  }
  final last = matches.last;
  return source.replaceRange(last.end, last.end, '\n$_kRestorerImport');
}

class _CoreRewriter extends RecursiveAstVisitor<void> {
  final String sourcePath;
  final LineInfo lineInfo;
  final List<SourceEdit> edits = [];

  _CoreRewriter(this.sourcePath, this.lineInfo);

  // ---------------------------------------------------------------------------
  // List literal → StaticList<T>.ofN(...)
  // ---------------------------------------------------------------------------

  @override
  void visitListLiteral(ListLiteral node) {
    super.visitListLiteral(node); // visit children first so inner edits land
    if (node.inConstantContext) {
      _error(
        node.offset,
        'List literal in a constant context cannot be rewritten to '
        '`StaticList.ofN` (arity factories are not const). Move the value out '
        'of the constant context or refactor.',
      );
    }
    for (final e in node.elements) {
      if (e is! Expression) {
        _error(
          e.offset,
          'List literal element `${e.toSource()}` is not supported by '
          'dart2cpp (no `for`, `if`, or `...spread` in this round). '
          'Refactor into plain expressions.',
        );
      }
    }
    final staticType = node.staticType;
    if (staticType is! InterfaceType) {
      _error(
        node.offset,
        'List literal has unresolved static type `$staticType`; dart2cpp '
        'needs a concrete element type. Add an explicit type argument.',
      );
    }
    if (staticType.element.name != 'List') {
      _error(
        node.offset,
        'List literal resolved to non-List type `$staticType`; dart2cpp '
        'cannot rewrite it.',
      );
    }
    final typeArgs = staticType.typeArguments;
    if (typeArgs.length != 1) {
      _error(
        node.offset,
        'List literal has unexpected type arguments `$typeArgs`.',
      );
    }
    final elemType = typeArgs[0];
    if (elemType is DynamicType) {
      _error(
        node.offset,
        'List literal element type is `dynamic`; dart2cpp refuses to '
        'produce `StaticList<dynamic>`. Add an explicit type argument or a '
        'typed receiver.',
      );
    }
    final n = node.elements.length;
    if (n > _kMaxListLiteralLen) {
      _error(
        node.offset,
        'List literal length $n exceeds dart2cpp limit '
        '($_kMaxListLiteralLen). Split into smaller groups, or add more '
        '`StaticList.ofN` factories and bump `_kMaxListLiteralLen` in '
        'lib/src/passes/rewrite_core_calls.dart.',
      );
    }
    final elemTypeText = elemType.getDisplayString();
    final left = node.leftBracket;
    final right = node.rightBracket;
    // Replace the head `<T>[` (or `[`) and the trailing `]` with two
    // surgical edits so any inner identifier rewrites (e.g. `print` →
    // `staticPrint`) inside the literal remain valid.
    edits.add(SourceEdit(
      node.offset,
      left.end - node.offset,
      'StaticList<$elemTypeText>.of$n(',
    ));
    edits.add(SourceEdit(right.offset, right.length, ')'));
  }

  // ---------------------------------------------------------------------------
  // print → staticPrint
  // ---------------------------------------------------------------------------

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    super.visitSimpleIdentifier(node);
    if (node.name != 'print') return;
    if (_isDeclarationPosition(node)) return;
    if (!_isDartCorePrintReference(node)) return;
    edits.add(SourceEdit(node.offset, node.length, 'staticPrint'));
  }

  bool _isDartCorePrintReference(SimpleIdentifier node) {
    final el = node.element;
    if (el is! TopLevelFunctionElement) return false;
    if (el.name != 'print') return false;
    final lib = el.library;
    return lib.uri.toString() == _kDartCoreUri;
  }

  bool _isDeclarationPosition(SimpleIdentifier node) {
    final parent = node.parent;
    if (parent is VariableDeclaration && parent.name == node.token) return true;
    if (parent is FormalParameter && parent.name == node.token) return true;
    if (parent is FunctionDeclaration && parent.name == node.token) return true;
    if (parent is MethodDeclaration && parent.name == node.token) return true;
    if (parent is ConstructorDeclaration) return true;
    if (parent is Label) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // List<T> type annotation → StaticList<T>
  // ---------------------------------------------------------------------------

  @override
  void visitNamedType(NamedType node) {
    super.visitNamedType(node);
    if (node.name.lexeme != 'List') return;
    final element = node.element;
    if (element is! ClassElement) return;
    if (element.library.uri.toString() != _kDartCoreUri) return;
    // Don't touch our own runtime classes file if it ever flows through here
    // (it shouldn't, because we operate only on the user's file via overlay).
    final lib = element.library.uri.toString();
    if (lib == _kRestorerUri) return;
    edits.add(SourceEdit(node.name.offset, node.name.length, 'StaticList'));
  }

  // ---------------------------------------------------------------------------

  Never _error(int offset, String message) {
    final loc = lineInfo.getLocation(offset);
    throw ConversionError(
      p.basename(sourcePath),
      loc.lineNumber,
      loc.columnNumber,
      message,
    );
  }
}
