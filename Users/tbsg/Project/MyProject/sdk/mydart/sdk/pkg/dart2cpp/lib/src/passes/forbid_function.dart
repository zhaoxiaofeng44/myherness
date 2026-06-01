import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;

import '../conversion_error.dart';

/// Pass 6 — final defence. Walk the converted AST and refuse to write the
/// output if a forbidden dart:core identifier slipped through. Operates on
/// AST nodes only, so identifiers inside comments and string literals are
/// naturally ignored.
///
/// Forbidden in business files:
///   * `Function` — type or identifier (no exceptions in business code)
///   * `List` — type or identifier (must come through `StaticList`)
///   * `print` — identifier (must come through `staticPrint`)
///   * `Iterable` — type or identifier (no business uses this round)
///
/// Whitelisted: `lib/restorer/runtime_classes.dart` — the restorer is the
/// ONLY place where bare `List`, `print`, etc. may appear post-conversion.
const Set<String> _forbiddenIdentifiers = {
  'Function',
  'List',
  'print',
  'Iterable',
};

const String _restorerRelative = 'lib/restorer/runtime_classes.dart';

void forbidFunction(String sourcePath, String source) {
  if (_isRestorerFile(sourcePath)) return;
  final parsed =
      parseString(content: source, path: sourcePath, throwIfDiagnostics: false);
  if (parsed.errors.isNotEmpty) {
    final first = parsed.errors.first;
    final loc = parsed.lineInfo.getLocation(first.offset);
    throw ConversionError(
      sourcePath, loc.lineNumber, loc.columnNumber,
      'Parse error in forbid-Function pass: ${first.message}',
    );
  }
  final visitor = _ForbidVisitor(sourcePath, parsed.lineInfo);
  parsed.unit.visitChildren(visitor);
}

bool _isRestorerFile(String sourcePath) {
  final canon = p.canonicalize(sourcePath).toLowerCase();
  return canon.endsWith(_restorerRelative.toLowerCase());
}

class _ForbidVisitor extends RecursiveAstVisitor<void> {
  final String sourcePath;
  final LineInfo lineInfo;

  _ForbidVisitor(this.sourcePath, this.lineInfo);

  @override
  void visitNamedType(NamedType node) {
    super.visitNamedType(node);
    final name = node.name.lexeme;
    if (_forbiddenIdentifiers.contains(name)) {
      _fail(node.offset,
          'Forbidden `$name` type leaked into converted output. A pass '
          'before forbid_function did not rewrite this annotation.');
    }
  }

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    super.visitSimpleIdentifier(node);
    final name = node.name;
    if (!_forbiddenIdentifiers.contains(name)) return;
    // Allow declarations (e.g. variable named `list` — no, we forbid the
    // identifier shape itself, including declarations). Per round-1 scope
    // any leaked declaration of these names is a bug worth catching.
    _fail(node.offset,
        'Forbidden `$name` identifier reference in converted output.');
  }

  Never _fail(int offset, String message) {
    final loc = lineInfo.getLocation(offset);
    throw ConversionError(sourcePath, loc.lineNumber, loc.columnNumber, message);
  }
}
