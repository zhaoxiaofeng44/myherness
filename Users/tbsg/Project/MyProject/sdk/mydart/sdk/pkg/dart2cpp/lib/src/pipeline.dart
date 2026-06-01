import 'dart:io';

import 'package:path/path.dart' as p;

import 'analysis/overlay_session.dart';
import 'passes/forbid_function.dart';
import 'passes/rewrite_core_calls.dart';
import 'passes/rewrite_function_type.dart';
import 'passes/rewrite_function_values.dart';

/// Runs the full dart2cpp conversion pipeline on a single source file.
///
/// Order matters and is fixed:
///   1. **Pass 7 (resolved AST)** rewrites every business-side reach into
///      `dart:core` (print, List literal, `List<T>` annotation, …) to call
///      the matching symbol in `package:dart2cpp/restorer/runtime_classes.dart`.
///      Injects the restorer import so subsequent passes can resolve the new
///      identifiers.
///   2. **Pass 4 (resolved AST)** rewrites every function value — closures,
///      tear-offs of top-level / static / instance / constructor executables
///      — to synthesised `TypeFunctionN` instances. Picks contextual type
///      arguments from the call site when the parameter slot is a
///      `TypeFunctionN<...>`.
///   3. **Pass 3 (syntactic)** rewrites the remaining `R Function(T...)`
///      type annotations to `TypeFunctionN<R, T...>`, and rejects any
///      surviving bare `Function`.
///   4. **Pass 6 (syntactic)** is the final defence — it walks the AST and
///      refuses to write out any forbidden identifier
///      (`Function` / `List` / `print` / `Iterable`) that slipped through.
///      Whitelisted: the restorer file itself.
Future<String> convertFileToString(String inputPath) async {
  final absPath = p.normalize(p.absolute(inputPath));
  final session = OverlaySession.open(absPath);
  try {
    final afterCore = await rewriteCoreCalls(session);
    await session.overlay(afterCore);
    final afterValues = await rewriteFunctionValues(session);
    final withImport = _ensureRuntimeImport(afterValues);
    final afterType = rewriteFunctionTypes(absPath, withImport);
    forbidFunction(absPath, afterType);
    return afterType;
  } finally {
    await session.dispose();
  }
}

Future<void> convertFile(String inputPath, String outputPath) async {
  final converted = await convertFileToString(inputPath);
  File(outputPath).writeAsStringSync(converted);
}

String _ensureRuntimeImport(String source) {
  const importLine =
      "import 'package:dart2cpp/runtime/type_function.dart';";
  if (source.contains(importLine)) return source;
  // Only inject when the converted file actually uses the runtime —
  // e.g. extends TypeFunctionN or refers to Cell. Without this guard
  // simple programs (a single print) carry an unused import warning.
  if (!source.contains('TypeFunction') && !source.contains('Cell<')) {
    return source;
  }
  final importRegex =
      RegExp('^import\\s+[\'\"][^\'\"]+[\'\"][^;]*;', multiLine: true);
  final matches = importRegex.allMatches(source).toList();
  if (matches.isEmpty) {
    return '$importLine\n\n$source';
  }
  final last = matches.last;
  return source.replaceRange(last.end, last.end, '\n$importLine');
}
