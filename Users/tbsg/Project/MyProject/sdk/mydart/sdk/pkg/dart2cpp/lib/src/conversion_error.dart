class ConversionError implements Exception {
  final String sourcePath;
  final int line;
  final int column;
  final String message;

  ConversionError(this.sourcePath, this.line, this.column, this.message);

  @override
  String toString() => '$sourcePath:$line:$column: $message';
}
