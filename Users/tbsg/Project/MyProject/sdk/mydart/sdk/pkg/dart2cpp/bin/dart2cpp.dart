import 'dart:io';

import 'package:dart2cpp/src/conversion_error.dart';
import 'package:dart2cpp/src/pipeline.dart';

const _usage =
    'Usage: dart run dart2cpp <input.dart> [-o <output.dart>]\n'
    '  Converts dynamic Dart source into the static-Dart dialect where every\n'
    '  function value is expressed via TypeFunctionN<R, T...> instead of the\n'
    '  built-in Function type.';

Future<void> main(List<String> args) async {
  String? input;
  String? output;
  for (var i = 0; i < args.length; i++) {
    final a = args[i];
    if (a == '-o' || a == '--output') {
      if (i + 1 >= args.length) {
        stderr.writeln('Missing argument to $a');
        exit(64);
      }
      output = args[++i];
    } else if (a == '-h' || a == '--help') {
      stdout.writeln(_usage);
      exit(0);
    } else if (input == null) {
      input = a;
    } else {
      stderr.writeln('Unexpected positional argument: $a');
      exit(64);
    }
  }
  if (input == null) {
    stderr.writeln(_usage);
    exit(64);
  }
  final inputFile = File(input);
  if (!inputFile.existsSync()) {
    stderr.writeln('Input file not found: $input');
    exit(66);
  }
  try {
    final converted = await convertFileToString(input);
    if (output == null) {
      stdout.write(converted);
    } else {
      File(output).writeAsStringSync(converted);
    }
  } on ConversionError catch (e) {
    stderr.writeln(e);
    exit(65);
  }
}
