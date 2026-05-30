import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/dart/element/type.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;

import '../conversion_error.dart';
import '../edits.dart';
import 'rewrite_function_type.dart' show kMaxArity;

/// Pass 4 (iteration 2) — resolved-AST-based rewrite that turns every
/// function value in the source into a `TypeFunctionN<R, T...>` instance:
///   * closures / function literals → synthesised `_Closure_N`
///   * top-level / static / instance / constructor tear-offs → synthesised
///     `_TearOff_<...>`, dedup by element identity
///   * generic tear-offs (the executable carries its own `<T>` formals) →
///     refuse with source position
///
/// Must run **before** the syntactic function-type rewrite (Pass 3) so that
/// inferred function types from the original `Function`-typed annotations are
/// still available to read.
Future<String> rewriteFunctionValues(String inputAbsPath) async {
  final collection =
      AnalysisContextCollection(includedPaths: [inputAbsPath]);
  final ctx = collection.contextFor(inputAbsPath);
  final result = await ctx.currentSession.getResolvedUnit(inputAbsPath);
  if (result is! ResolvedUnitResult) {
    throw ConversionError(
      inputAbsPath, 1, 1,
      'Could not resolve unit (${result.runtimeType}). dart2cpp Pass 4 needs '
      'the input file to live inside a pub package so analyzer can resolve '
      'its imports.',
    );
  }
  final source = File(inputAbsPath).readAsStringSync();
  final visitor = _Rewriter(inputAbsPath, source, result.lineInfo);
  result.unit.visitChildren(visitor);
  final rewritten = applyEdits(source, visitor.edits);
  if (visitor.appended.isEmpty) return rewritten;
  final buffer = StringBuffer(rewritten);
  if (!rewritten.endsWith('\n')) buffer.writeln();
  buffer.writeln();
  buffer.writeln('// --- dart2cpp synthesised TypeFunction subclasses ---');
  buffer.write(visitor.appended.toString());
  return buffer.toString();
}

class _Rewriter extends RecursiveAstVisitor<void> {
  final String sourcePath;
  final String source;
  final LineInfo lineInfo;
  final List<SourceEdit> edits = [];
  final StringBuffer appended = StringBuffer();

  /// element → generated class name (top-level / static / constructor)
  final Map<Element, String> _topLevelOrStaticByElement = {};

  /// element → generated class name (instance methods are also dedup'd because
  /// the class is parameterised over the receiver — each call site just
  /// instantiates with its own receiver).
  final Map<Element, String> _instanceMethodByElement = {};

  int _closureCounter = 0;
  final Set<String> _usedClassNames = {};

  _Rewriter(this.sourcePath, this.source, this.lineInfo);

  // ---------------------------------------------------------------------------
  // Visit entry points
  // ---------------------------------------------------------------------------

  @override
  void visitFunctionExpression(FunctionExpression node) {
    super.visitFunctionExpression(node);
    if (node.parent is FunctionDeclaration) return; // top-level or method body
    _handleClosure(node);
  }

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    super.visitSimpleIdentifier(node);
    if (_shouldSkipIdentifier(node)) return;
    final type = node.staticType;
    if (type is! FunctionType) return;
    final element = node.element;
    if (!_isTearOffableExecutable(element)) return;
    _wrapTearOff(node, element as ExecutableElement, type,
        receiverSource: null);
  }

  @override
  void visitPrefixedIdentifier(PrefixedIdentifier node) {
    super.visitPrefixedIdentifier(node);
    if (_isFunctionInvocationCallee(node)) return;
    final type = node.staticType;
    if (type is! FunctionType) return;
    final element = node.identifier.element;
    if (!_isTearOffableExecutable(element)) return;

    final prefixElement = node.prefix.element;
    if (prefixElement is ClassElement ||
        prefixElement is PrefixElement ||
        prefixElement is EnumElement) {
      _wrapTearOff(node, element as ExecutableElement, type,
          receiverSource: null);
      return;
    }
    _wrapTearOff(node, element as ExecutableElement, type,
        receiverSource: node.prefix.toSource(),
        receiverType: node.prefix.staticType);
  }

  @override
  void visitPropertyAccess(PropertyAccess node) {
    super.visitPropertyAccess(node);
    if (_isFunctionInvocationCallee(node)) return;
    final type = node.staticType;
    if (type is! FunctionType) return;
    final element = node.propertyName.element;
    if (!_isTearOffableExecutable(element)) return;
    final target = node.realTarget;
    _wrapTearOff(node, element as ExecutableElement, type,
        receiverSource: target.toSource(),
        receiverType: target.staticType);
  }

  bool _isTearOffableExecutable(Element? element) {
    if (element == null) return false;
    // Genuine callables only — exclude getters/setters because their result
    // is the value returned, not a tear-off of the accessor itself.
    if (element is PropertyAccessorElement) return false;
    return element is MethodElement ||
        element is TopLevelFunctionElement ||
        element is LocalFunctionElement ||
        element is ConstructorElement;
  }

  bool _isFunctionInvocationCallee(AstNode node) {
    final parent = node.parent;
    return parent is FunctionExpressionInvocation && parent.function == node;
  }

  // ---------------------------------------------------------------------------
  // Skip / classification helpers
  // ---------------------------------------------------------------------------

  bool _shouldSkipIdentifier(SimpleIdentifier node) {
    final parent = node.parent;
    // Declaration positions.
    if (parent is VariableDeclaration && parent.name == node.token) return true;
    if (parent is FormalParameter && parent.name == node.token) return true;
    if (parent is FunctionDeclaration && parent.name == node.token) return true;
    if (parent is MethodDeclaration && parent.name == node.token) return true;
    if (parent is ConstructorDeclaration) return true;
    if (parent is Label) return true;
    // NamedArgument's name is a bare Token (not a SimpleIdentifier node) in
    // analyzer 13, so it never matches `node` here.
    // Already-handled-by-parent positions.
    if (parent is PrefixedIdentifier) return true;
    if (parent is PropertyAccess && parent.propertyName == node) return true;
    // Direct invocation: `print('hi')`, `obj.foo()` (foo here is methodName).
    if (parent is MethodInvocation && parent.methodName == node) return true;
    // `cb()` where `cb` is a top-level variable parses as
    // FunctionExpressionInvocation(function: SimpleIdentifier('cb')). The
    // identifier is the callee, not a tear-off.
    if (parent is FunctionExpressionInvocation && parent.function == node) {
      return true;
    }
    // Constructor name parts.
    if (parent is ConstructorName) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Tear-off wrapping
  // ---------------------------------------------------------------------------

  void _wrapTearOff(
    Expression node,
    ExecutableElement element,
    FunctionType type, {
    required String? receiverSource,
    DartType? receiverType,
  }) {
    // Skip if the element name already starts with TypeFunction — defensive.
    final eName = element.name ?? '';
    if (eName.startsWith('TypeFunction')) return;

    // Generic tear-off: type still carries its own formals — we cannot pick
    // concrete type arguments here, so refuse with source position.
    if (type.typeParameters.isNotEmpty) {
      _error(
        node.offset,
        'Cannot instantiate generic tear-off `${node.toSource()}` '
        '(`${_typeText(type)}`). dart2cpp requires the type arguments to be '
        'pinned at the source site; assign through an explicit '
        '`TypeFunctionN<...>` declaration or refactor.',
      );
    }
    if (type.formalParameters.length > kMaxArity) {
      _error(
        node.offset,
        'Tear-off arity ${type.formalParameters.length} exceeds dart2cpp '
        'limit ($kMaxArity); raise kMaxArity in '
        'lib/src/passes/rewrite_function_type.dart and add the matching '
        'TypeFunction class.',
      );
    }

    final isInstance = receiverSource != null;
    final dedup = isInstance ? _instanceMethodByElement : _topLevelOrStaticByElement;
    var className = dedup[element];
    if (className == null) {
      className = _generateClassName(element, isInstance: isInstance);
      dedup[element] = className;
      _emitTearOffClass(
        className: className,
        element: element,
        type: type,
        isInstance: isInstance,
        receiverTypeText: isInstance ? _typeText(receiverType!) : null,
      );
    }

    final replacement = isInstance
        ? '$className($receiverSource)'
        : 'const $className()';
    edits.add(SourceEdit(node.offset, node.length, replacement));
  }

  String _generateClassName(ExecutableElement element,
      {required bool isInstance}) {
    final name = element.name ?? 'anon';
    final enclosing = element.enclosingElement;
    String base;
    if (element is ConstructorElement) {
      final clsName = (enclosing is ClassElement) ? enclosing.name : 'ctor';
      base = name.isEmpty
          ? '_TearOff_${clsName}_ctor'
          : '_TearOff_${clsName}_ctor_$name';
    } else if (enclosing is ClassElement || enclosing is EnumElement) {
      final clsName = (enclosing as dynamic).name ?? 'cls';
      base = '_TearOff_${clsName}_$name';
    } else {
      base = '_TearOff_$name';
    }
    var candidate = base;
    var i = 2;
    while (_usedClassNames.contains(candidate)) {
      candidate = '${base}_$i';
      i++;
    }
    _usedClassNames.add(candidate);
    return candidate;
  }

  void _emitTearOffClass({
    required String className,
    required ExecutableElement element,
    required FunctionType type,
    required bool isInstance,
    required String? receiverTypeText,
  }) {
    final params = type.formalParameters;
    final arity = params.length;
    final returnText = _typeText(type.returnType);
    final paramTexts = [
      for (final p in params) _typeText(p.type),
    ];
    final paramNames = [
      for (var i = 0; i < params.length; i++) 'a${i + 1}',
    ];
    final typeArgs = [returnText, ...paramTexts].join(', ');
    final callParams = [
      for (var i = 0; i < arity; i++) '${paramTexts[i]} ${paramNames[i]}',
    ].join(', ');
    final callArgs = paramNames.join(', ');

    final targetCall = _buildTargetCall(element, callArgs, isInstance);

    appended.writeln();
    appended.writeln('class $className extends TypeFunction$arity<$typeArgs> {');
    if (isInstance) {
      appended.writeln('  final $receiverTypeText _r;');
      appended.writeln('  $className(this._r);');
    } else {
      appended.writeln('  const $className();');
    }
    appended.writeln('  @override');
    appended.writeln('  $returnText call($callParams) => $targetCall;');
    appended.writeln('}');
  }

  String _buildTargetCall(
      ExecutableElement element, String callArgs, bool isInstance) {
    final name = element.name ?? '';
    final enclosing = element.enclosingElement;
    if (element is ConstructorElement) {
      final clsName = (enclosing is ClassElement) ? enclosing.name : '';
      return name.isEmpty
          ? '$clsName($callArgs)'
          : '$clsName.$name($callArgs)';
    }
    if (isInstance) {
      return '_r.$name($callArgs)';
    }
    // Top-level or static.
    if (enclosing is ClassElement || enclosing is EnumElement) {
      final clsName = (enclosing as dynamic).name;
      return '$clsName.$name($callArgs)';
    }
    return '$name($callArgs)';
  }

  // ---------------------------------------------------------------------------
  // Closure literal handling (resolved-type-driven)
  // ---------------------------------------------------------------------------

  void _handleClosure(FunctionExpression node) {
    final staticType = node.staticType;
    if (staticType is! FunctionType) {
      _error(node.offset,
          'Closure has no static FunctionType (got `${staticType}`); cannot '
          'derive arity / return type.');
    }
    if (staticType.typeParameters.isNotEmpty) {
      _error(node.offset,
          'Generic closures (with their own `<T>` parameters) are not '
          'supported by dart2cpp.');
    }
    final params = node.parameters?.parameters ?? const <FormalParameter>[];
    if (params.length > kMaxArity) {
      _error(node.offset,
          'Closure arity ${params.length} exceeds kMaxArity ($kMaxArity).');
    }

    final paramTypes = [
      for (final fp in staticType.formalParameters) _typeText(fp.type),
    ];
    final paramNames = <String>[];
    for (var i = 0; i < params.length; i++) {
      final tok = params[i].name;
      paramNames.add(tok?.lexeme ?? 'a${i + 1}');
    }
    final returnText = _typeText(staticType.returnType);

    // Free-variable capture by element identity.
    final captured = _captureLocals(node);

    final className = _freshClosureName();
    final arity = paramTypes.length;
    final typeArgs = [returnText, ...paramTypes].join(', ');

    final fieldLines = <String>[
      for (final c in captured) '  final ${c.typeText} ${c.name};',
    ];
    final ctorParams = [for (final c in captured) 'this.${c.name}'].join(', ');
    final callSig = [
      for (var i = 0; i < arity; i++) '${paramTypes[i]} ${paramNames[i]}',
    ].join(', ');

    final bodySource = node.body.toSource();
    final bodyForClass = node.body is ExpressionFunctionBody &&
            !bodySource.trimRight().endsWith(';')
        ? '$bodySource;'
        : bodySource;

    appended.writeln();
    appended.writeln('class $className extends TypeFunction$arity<$typeArgs> {');
    for (final f in fieldLines) {
      appended.writeln(f);
    }
    appended.writeln('  $className($ctorParams);');
    appended.writeln('  @override');
    appended.writeln('  $returnText call($callSig) $bodyForClass');
    appended.writeln('}');

    final ctorArgs = captured.map((c) => c.name).join(', ');
    edits.add(SourceEdit(node.offset, node.length, '$className($ctorArgs)'));
  }

  String _freshClosureName() {
    _closureCounter++;
    var candidate = '_Closure_$_closureCounter';
    while (_usedClassNames.contains(candidate)) {
      _closureCounter++;
      candidate = '_Closure_$_closureCounter';
    }
    _usedClassNames.add(candidate);
    return candidate;
  }

  List<_Captured> _captureLocals(FunctionExpression closure) {
    // Walk the closure body and pick out element references that resolve to
    // locals / parameters declared OUTSIDE the closure but INSIDE the
    // enclosing function. Use element identity so we don't accidentally
    // capture top-level / imported things.
    final boundary = _enclosingFunctionBody(closure);
    if (boundary == null) return const [];
    final ownParams = <Element>{};
    for (final fp in closure.parameters?.parameters ??
        const <FormalParameter>[]) {
      final el = fp.declaredFragment?.element;
      if (el != null) ownParams.add(el);
    }
    final ownLocals = <Element>{};
    closure.body.visitChildren(_LocalDeclCollector(ownLocals));

    final collector = _UsedElementCollector(closure);
    closure.body.visitChildren(collector);

    final captured = <_Captured>[];
    final seen = <Element>{};
    for (final entry in collector.uses) {
      final el = entry.element;
      if (seen.contains(el)) continue;
      if (ownParams.contains(el)) continue;
      if (ownLocals.contains(el)) continue;
      if (!_isInsideBoundary(el, boundary)) continue;
      seen.add(el);
      captured.add(_Captured(entry.name, _typeText(entry.type)));
    }
    return captured;
  }

  AstNode? _enclosingFunctionBody(FunctionExpression closure) {
    AstNode? cur = closure.parent;
    while (cur != null) {
      if (cur is FunctionDeclaration ||
          cur is MethodDeclaration ||
          cur is ConstructorDeclaration) {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  bool _isInsideBoundary(Element el, AstNode boundary) {
    // Walk up the element's enclosing chain — if we hit a function/method
    // whose AST is `boundary`, the local is in scope.
    Element? cur = el.enclosingElement;
    while (cur != null) {
      if (cur is ExecutableElement) {
        // Compare by name + offset against the boundary's declaration.
        if (boundary is FunctionDeclaration &&
            boundary.name.lexeme == cur.name) {
          return true;
        }
        if (boundary is MethodDeclaration &&
            boundary.name.lexeme == cur.name) {
          return true;
        }
        if (boundary is ConstructorDeclaration && cur is ConstructorElement) {
          return true;
        }
        return false;
      }
      cur = cur.enclosingElement;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  String _typeText(DartType? t) {
    if (t == null) return 'dynamic';
    return t.getDisplayString();
  }

  Never _error(int offset, String message) {
    final loc = lineInfo.getLocation(offset);
    throw ConversionError(
        p.basename(sourcePath), loc.lineNumber, loc.columnNumber, message);
  }
}

class _Captured {
  final String name;
  final String typeText;
  _Captured(this.name, this.typeText);
}

class _LocalDeclCollector extends RecursiveAstVisitor<void> {
  final Set<Element> out;
  _LocalDeclCollector(this.out);

  @override
  void visitVariableDeclaration(VariableDeclaration node) {
    super.visitVariableDeclaration(node);
    final el = node.declaredFragment?.element;
    if (el != null) out.add(el);
  }
}

class _UsedElementCollector extends RecursiveAstVisitor<void> {
  final List<_Use> uses = [];
  _UsedElementCollector(FunctionExpression _);

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    super.visitSimpleIdentifier(node);
    final parent = node.parent;
    if (parent is VariableDeclaration && parent.name == node.token) return;
    if (parent is FormalParameter && parent.name == node.token) return;
    if (parent is FunctionDeclaration && parent.name == node.token) return;
    if (parent is MethodDeclaration && parent.name == node.token) return;
    if (parent is ConstructorDeclaration) return;
    if (parent is PropertyAccess && parent.propertyName == node) return;
    if (parent is PrefixedIdentifier && parent.identifier == node) return;
    if (parent is Label) return;
    // NamedArgument.name is a Token in analyzer 13 — no SimpleIdentifier
    // child to skip here.
    if (parent is MethodInvocation &&
        parent.methodName == node &&
        parent.target != null) return;
    final el = node.element;
    if (el == null) return;
    if (el is LocalVariableElement ||
        el is FormalParameterElement) {
      uses.add(_Use(node.name, el, node.staticType));
    }
  }
}

class _Use {
  final String name;
  final Element element;
  final DartType? type;
  _Use(this.name, this.element, this.type);
}
