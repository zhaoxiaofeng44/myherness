class SourceEdit {
  final int offset;
  final int length;
  final String replacement;

  SourceEdit(this.offset, this.length, this.replacement);

  int get end => offset + length;
}

/// Applies edits from end to start so earlier offsets remain valid. Overlapping
/// edits (same range, or strictly overlapping ranges) throw; callers must split
/// or merge edits before handing them to this function.
String applyEdits(String source, List<SourceEdit> edits) {
  if (edits.isEmpty) return source;
  final sorted = [...edits]..sort((a, b) => a.offset.compareTo(b.offset));
  for (var i = 1; i < sorted.length; i++) {
    final prev = sorted[i - 1];
    final cur = sorted[i];
    if (cur.offset < prev.end) {
      throw StateError(
        'Overlapping edits: '
        '(${prev.offset}, ${prev.length}) vs (${cur.offset}, ${cur.length})',
      );
    }
  }
  final buffer = StringBuffer();
  var cursor = 0;
  for (final e in sorted) {
    buffer.write(source.substring(cursor, e.offset));
    buffer.write(e.replacement);
    cursor = e.end;
  }
  buffer.write(source.substring(cursor));
  return buffer.toString();
}
