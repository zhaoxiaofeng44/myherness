import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/file_system/overlay_file_system.dart';
import 'package:analyzer/file_system/physical_file_system.dart';

import '../conversion_error.dart';

/// Wraps one [AnalysisContextCollection] backed by an [OverlayResourceProvider]
/// so multiple passes (Pass 7, Pass 4) can share a single analyzer setup and
/// pass rewritten source through in-memory overlays — no temp side-files on
/// disk, no pubspec pollution, no concurrent-cleanup hazards.
class OverlaySession {
  final String absPath;
  final OverlayResourceProvider _overlay;
  final AnalysisContextCollection _collection;

  OverlaySession._(this.absPath, this._overlay, this._collection);

  static OverlaySession open(String absPath) {
    final overlay = OverlayResourceProvider(PhysicalResourceProvider.INSTANCE);
    final collection = AnalysisContextCollection(
      includedPaths: [absPath],
      resourceProvider: overlay,
    );
    return OverlaySession._(absPath, overlay, collection);
  }

  /// Current source as the analyzer sees it (overlay if present, else disk).
  String currentSource() {
    final content = _overlay.hasOverlay(absPath)
        ? _overlay.getFile(absPath).readAsStringSync()
        : File(absPath).readAsStringSync();
    return content;
  }

  /// Overlay the file with [content] and force the analyzer to re-resolve it
  /// next time [resolved] is called.
  Future<void> overlay(String content) async {
    _overlay.setOverlay(
      absPath,
      content: content,
      modificationStamp: DateTime.now().microsecondsSinceEpoch,
    );
    final ctx = _collection.contextFor(absPath);
    ctx.changeFile(absPath);
    await ctx.applyPendingFileChanges();
  }

  /// Get a resolved unit for the file.
  Future<ResolvedUnitResult> resolved() async {
    final ctx = _collection.contextFor(absPath);
    final result = await ctx.currentSession.getResolvedUnit(absPath);
    if (result is! ResolvedUnitResult) {
      throw ConversionError(
        absPath,
        1,
        1,
        'Could not resolve unit (${result.runtimeType}). dart2cpp needs the '
        'input file to live inside a pub package so analyzer can resolve its '
        'imports.',
      );
    }
    return result;
  }

  Future<void> dispose() async => _collection.dispose();
}
