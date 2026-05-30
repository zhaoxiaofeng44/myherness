import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';

import '../conversion_error.dart';

/// Pass 6 — final defence. Walk the converted AST and refuse to write the
/// output if any `Function` identifier slipped through. Operates on AST nodes
/// only, so identifiers inside comments and string literals are naturally
/// ignored.
void forbidFunction(String sourcePath, String source) {
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

class _ForbidVisitor extends RecursiveAstVisitor<void> {
  final String sourcePath;
  final LineInfo lineInfo;

  _ForbidVisitor(this.sourcePath, this.lineInfo);

  @override
  void visitNamedType(NamedType node) {
    super.visitNamedType(node);
    final name = node.name.lexeme;
    if (name == 'Function') {
      _fail(node.offset,
          'Forbidden `Function` type leaked into converted output. '
          'A pass before forbid_function did not rewrite this annotation.');
    }
  }

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    super.visitSimpleIdentifier(node);
    if (node.name != 'Function') return;
    // Allow `TypeFunction` and friends — those are different lexemes, so
    // `node.name == 'Function'` only matches the bare identifier.
    _fail(node.offset,
        'Forbidden `Function` identifier reference in converted output.');
  }

  Never _fail(int offset, String message) {
    final loc = lineInfo.getLocation(offset);
    throw ConversionError(sourcePath, loc.lineNumber, loc.columnNumber, message);
  }
}
