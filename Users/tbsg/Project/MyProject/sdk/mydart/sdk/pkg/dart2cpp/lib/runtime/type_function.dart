// TypeFunction runtime.
//
// Notation: `TypeFunction<R, T...>` is the umbrella name used throughout the
// dart2cpp documentation for *any* function-value type. Dart has no variadic
// generics, so it is realised as one common base `TypeFunction<R>` plus an
// arity-indexed family `TypeFunction0<R> .. TypeFunctionN<R, T1..TN>`. Every
// converted closure, tear-off and function-typed parameter lands on exactly
// one of these subclasses; the `Function` type is never used in converted
// code.
//
// Current arity ceiling: 8. Source programs that need a higher arity must be
// refactored, or the ceiling must be raised here (and `kMaxArity` in the
// converter kept in sync).

abstract class TypeFunction<R> {
  const TypeFunction();

  /// Arity of this function value (number of positional parameters of `call`).
  int get arity;
}

abstract class TypeFunction0<R> extends TypeFunction<R> {
  const TypeFunction0();
  @override
  int get arity => 0;
  R call();
}

abstract class TypeFunction1<R, T1> extends TypeFunction<R> {
  const TypeFunction1();
  @override
  int get arity => 1;
  R call(T1 a1);
}

abstract class TypeFunction2<R, T1, T2> extends TypeFunction<R> {
  const TypeFunction2();
  @override
  int get arity => 2;
  R call(T1 a1, T2 a2);
}

abstract class TypeFunction3<R, T1, T2, T3> extends TypeFunction<R> {
  const TypeFunction3();
  @override
  int get arity => 3;
  R call(T1 a1, T2 a2, T3 a3);
}

abstract class TypeFunction4<R, T1, T2, T3, T4> extends TypeFunction<R> {
  const TypeFunction4();
  @override
  int get arity => 4;
  R call(T1 a1, T2 a2, T3 a3, T4 a4);
}

abstract class TypeFunction5<R, T1, T2, T3, T4, T5> extends TypeFunction<R> {
  const TypeFunction5();
  @override
  int get arity => 5;
  R call(T1 a1, T2 a2, T3 a3, T4 a4, T5 a5);
}

abstract class TypeFunction6<R, T1, T2, T3, T4, T5, T6>
    extends TypeFunction<R> {
  const TypeFunction6();
  @override
  int get arity => 6;
  R call(T1 a1, T2 a2, T3 a3, T4 a4, T5 a5, T6 a6);
}

abstract class TypeFunction7<R, T1, T2, T3, T4, T5, T6, T7>
    extends TypeFunction<R> {
  const TypeFunction7();
  @override
  int get arity => 7;
  R call(T1 a1, T2 a2, T3 a3, T4 a4, T5 a5, T6 a6, T7 a7);
}

abstract class TypeFunction8<R, T1, T2, T3, T4, T5, T6, T7, T8>
    extends TypeFunction<R> {
  const TypeFunction8();
  @override
  int get arity => 8;
  R call(T1 a1, T2 a2, T3 a3, T4 a4, T5 a5, T6 a6, T7 a7, T8 a8);
}

/// Box used by the closure-rewriting pass to preserve write semantics for
/// captured local variables. The pass converts `var x = ...` into
/// `final x = Cell<T>(...)` whenever `x` is mutated inside a closure.
class Cell<T> {
  T value;
  Cell(this.value);
}
