import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';

import 'package:dart2cpp/src/passes/rewrite_function_type.dart' show kMaxArity;

/// Sanity check that lib/runtime/type_function.dart declares
/// `TypeFunction<R>` plus `TypeFunction0..TypeFunctionN` with the expected
/// inheritance shape. Exit code 0 means PASS.
void main() {
  final file = File('lib/runtime/type_function.dart');
  if (!file.existsSync()) {
    stderr.writeln('lib/runtime/type_function.dart missing');
    exit(1);
  }
  final unit = parseString(content: file.readAsStringSync()).unit;
  final classes = unit.declarations.whereType<ClassDeclaration>().toList();
  final byName = <String, ClassDeclaration>{};
  for (final c in classes) {
    final part = c.namePart;
    if (part is NameWithTypeParameters) {
      byName[part.typeName.lexeme] = c;
    }
  }

  final baseName = 'TypeFunction';
  if (!byName.containsKey(baseName)) {
    stderr.writeln('Missing base class `TypeFunction<R>`');
    exit(1);
  }

  for (var n = 0; n <= kMaxArity; n++) {
    final name = 'TypeFunction$n';
    final cls = byName[name];
    if (cls == null) {
      stderr.writeln('Missing $name');
      exit(1);
    }
    final ext = cls.extendsClause?.superclass.name.lexeme;
    if (ext != 'TypeFunction') {
      stderr.writeln('$name does not extend TypeFunction (saw $ext)');
      exit(1);
    }
  }

  stdout.writeln('OK — TypeFunction0..TypeFunction$kMaxArity all present.');
}
