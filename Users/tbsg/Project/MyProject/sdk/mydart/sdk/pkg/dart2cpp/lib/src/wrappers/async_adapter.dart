import 'dart:async';

import '../../runtime/type_function.dart';

class _Async0<R> extends TypeFunction0<Future<R>> {
  final TypeFunction0<R> _src;
  _Async0(this._src);
  @override
  Future<R> call() async => _src.call();
}

class _Async1<R, T1> extends TypeFunction1<Future<R>, T1> {
  final TypeFunction1<R, T1> _src;
  _Async1(this._src);
  @override
  Future<R> call(T1 a1) async => _src.call(a1);
}

class _Async2<R, T1, T2> extends TypeFunction2<Future<R>, T1, T2> {
  final TypeFunction2<R, T1, T2> _src;
  _Async2(this._src);
  @override
  Future<R> call(T1 a1, T2 a2) async => _src.call(a1, a2);
}

TypeFunction0<Future<R>> toAsync0<R>(TypeFunction0<R> f) => _Async0<R>(f);
TypeFunction1<Future<R>, T1> toAsync1<R, T1>(TypeFunction1<R, T1> f) =>
    _Async1<R, T1>(f);
TypeFunction2<Future<R>, T1, T2> toAsync2<R, T1, T2>(
        TypeFunction2<R, T1, T2> f) =>
    _Async2<R, T1, T2>(f);
