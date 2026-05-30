import 'dart:io';

import 'package:path/path.dart' as p;

import 'passes/forbid_function.dart';
import 'passes/rewrite_function_type.dart';
import 'passes/rewrite_function_values.dart';

/// Runs the full dart2cpp conversion pipeline on a single source file.
///
/// Order matters and is fixed:
///   1. **Pass 4 (resolved AST)** rewrites every function value — closures,
///      tear-offs of top-level / static / instance / constructor executables —
///      to synthesised `TypeFunctionN` instances. This pass needs an
///      on-disk file inside a pub package so the analyzer can resolve
///      imports. Generic tear-offs and other unsupported function-valued
///      expressions fail here with a source location.
///   2. **Pass 3 (syntactic)** rewrites the remaining `R Function(T...)`
///      type annotations to `TypeFunctionN<R, T...>`, and rejects any
///      surviving bare `Function`.
///   3. **Pass 6 (syntactic)** is the final defence — it walks the AST and
///      refuses to write out any `Function` identifier that slipped through.
Future<String> convertFileToString(String inputPath) async {
  final absPath = p.normalize(p.absolute(inputPath));
  final afterValues = await rewriteFunctionValues(absPath);
  final withImport = _ensureRuntimeImport(afterValues);
  final afterType = rewriteFunctionTypes(absPath, withImport);
  forbidFunction(absPath, afterType);
  return afterType;
}

Future<void> convertFile(String inputPath, String outputPath) async {
  final converted = await convertFileToString(inputPath);
  File(outputPath).writeAsStringSync(converted);
}

String _ensureRuntimeImport(String source) {
  const importLine =
      "import 'package:dart2cpp/runtime/type_function.dart';";
  if (source.contains(importLine)) return source;
  final importRegex =
      RegExp('^import\\s+[\'\"][^\'\"]+[\'\"][^;]*;', multiLine: true);
  final matches = importRegex.allMatches(source).toList();
  if (matches.isEmpty) {
    return '$importLine\n\n$source';
  }
  final last = matches.last;
  return source.replaceRange(last.end, last.end, '\n$importLine');
}
