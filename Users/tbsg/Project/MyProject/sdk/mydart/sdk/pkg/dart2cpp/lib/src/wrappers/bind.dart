import '../../runtime/type_function.dart';

class _Bound2<R, T1, T2> extends TypeFunction1<R, T2> {
  final TypeFunction2<R, T1, T2> _src;
  final T1 _a1;
  _Bound2(this._src, this._a1);
  @override
  R call(T2 a2) => _src.call(_a1, a2);
}

class _Bound3First<R, T1, T2, T3> extends TypeFunction2<R, T2, T3> {
  final TypeFunction3<R, T1, T2, T3> _src;
  final T1 _a1;
  _Bound3First(this._src, this._a1);
  @override
  R call(T2 a2, T3 a3) => _src.call(_a1, a2, a3);
}

TypeFunction1<R, T2> bindFirst2<R, T1, T2>(
        TypeFunction2<R, T1, T2> f, T1 v) =>
    _Bound2<R, T1, T2>(f, v);

TypeFunction2<R, T2, T3> bindFirst3<R, T1, T2, T3>(
        TypeFunction3<R, T1, T2, T3> f, T1 v) =>
    _Bound3First<R, T1, T2, T3>(f, v);
