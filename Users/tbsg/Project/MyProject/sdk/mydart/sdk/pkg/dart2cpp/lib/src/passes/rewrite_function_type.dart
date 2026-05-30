import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';

import '../conversion_error.dart';
import '../edits.dart';

const int kMaxArity = 8;

/// Pass 3 — rewrite every `R Function(T1, T2, ...)` type annotation to the
/// matching `TypeFunctionN<R, T1, T2, ...>`, and reject any bare `Function`.
String rewriteFunctionTypes(String sourcePath, String source) {
  final parsed = parseString(
      content: source, path: sourcePath, throwIfDiagnostics: false);
  if (parsed.errors.isNotEmpty) {
    final first = parsed.errors.first;
    final loc = parsed.lineInfo.getLocation(first.offset);
    throw ConversionError(
      sourcePath,
      loc.lineNumber,
      loc.columnNumber,
      'Parse error before function-type rewrite: ${first.message}',
    );
  }
  final visitor = _FunctionTypeRewriter(sourcePath, parsed.lineInfo);
  parsed.unit.visitChildren(visitor);
  return applyEdits(source, visitor.edits);
}

class _FunctionTypeRewriter extends RecursiveAstVisitor<void> {
  final String sourcePath;
  final LineInfo lineInfo;
  final List<SourceEdit> edits = [];

  _FunctionTypeRewriter(this.sourcePath, this.lineInfo);

  @override
  void visitNamedType(NamedType node) {
    super.visitNamedType(node);
    if (_isBareFunction(node)) {
      _error(
        node.offset,
        'Bare `Function` type is not allowed in dart2cpp inputs: '
        'cannot infer arity from a name with no signature. '
        'Declare the full signature (e.g. `void Function(int)`) or use a '
        '`TypeFunctionN<R, T...>` subclass directly.',
      );
    }
  }

  @override
  void visitGenericFunctionType(GenericFunctionType node) {
    super.visitGenericFunctionType(node);
    if (_hasGenericFunctionTypeAncestor(node)) return;
    final converted = _convertType(node);
    edits.add(SourceEdit(node.offset, node.length, converted));
  }

  bool _isBareFunction(NamedType node) {
    if (node.name.lexeme != 'Function') return false;
    if (node.typeArguments != null) return false;
    return true;
  }

  bool _hasGenericFunctionTypeAncestor(AstNode node) {
    var p = node.parent;
    while (p != null) {
      if (p is GenericFunctionType) return true;
      p = p.parent;
    }
    return false;
  }

  String _convertType(TypeAnnotation node) {
    if (node is GenericFunctionType) {
      if (node.typeParameters != null) {
        _error(
          node.offset,
          'Generic function types (e.g. `T Function<T>(T)`) are not supported.',
        );
      }
      final params = node.parameters.parameters;
      for (final p in params) {
        if (p.defaultClause != null || p.isOptional || p.isNamed) {
          _error(
            p.offset,
            'Named or optional parameters in function types are not supported. '
            'Rewrite the signature with positional required parameters only.',
          );
        }
      }
      if (params.length > kMaxArity) {
        _error(
          node.offset,
          'Function type arity ${params.length} exceeds dart2cpp limit '
          '($kMaxArity). Raise kMaxArity and add a TypeFunction${params.length}'
          ' class in lib/runtime/type_function.dart to extend the ceiling.',
        );
      }
      final returnText = node.returnType == null
          ? 'dynamic'
          : _convertType(node.returnType!);
      final paramTexts = <String>[];
      for (final p in params) {
        paramTexts.add(_paramTypeText(p));
      }
      final arity = paramTexts.length;
      final typeArgs = [returnText, ...paramTexts].join(', ');
      final suffix = node.question == null ? '' : '?';
      return 'TypeFunction$arity<$typeArgs>$suffix';
    }
    if (node is NamedType) {
      if (_isBareFunction(node)) {
        _error(
          node.offset,
          'Bare `Function` type is not allowed; specify arity and types.',
        );
      }
      if (node.typeArguments == null) return node.toSource();
      final base = node.name.lexeme;
      final prefix = node.importPrefix;
      final prefixText = prefix == null ? '' : '${prefix.name.lexeme}.';
      final args =
          node.typeArguments!.arguments.map(_convertType).join(', ');
      final q = node.question == null ? '' : '?';
      return '$prefixText$base<$args>$q';
    }
    return node.toSource();
  }

  String _paramTypeText(FormalParameter p) {
    if (p.functionTypedSuffix != null) {
      // Inline function-typed param: `void cb(int x)` inside a function type.
      final suf = p.functionTypedSuffix!;
      final retText =
          p.type == null ? 'dynamic' : _convertType(p.type!);
      final innerParams = suf.formalParameters.parameters;
      if (innerParams.length > kMaxArity) {
        _error(p.offset,
            'Inline function-typed param exceeds kMaxArity ($kMaxArity).');
      }
      final innerTexts = innerParams.map(_paramTypeText).toList();
      final innerArgs = [retText, ...innerTexts].join(', ');
      return 'TypeFunction${innerParams.length}<$innerArgs>';
    }
    return p.type == null ? 'dynamic' : _convertType(p.type!);
  }

  Never _error(int offset, String message) {
    final loc = lineInfo.getLocation(offset);
    throw ConversionError(sourcePath, loc.lineNumber, loc.columnNumber, message);
  }
}
