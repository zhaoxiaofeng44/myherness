import '../../runtime/type_function.dart';

class _Curried2<R, T1, T2>
    extends TypeFunction1<TypeFunction1<R, T2>, T1> {
  final TypeFunction2<R, T1, T2> _src;
  _Curried2(this._src);
  @override
  TypeFunction1<R, T2> call(T1 a1) => _CurriedRem2<R, T1, T2>(_src, a1);
}

class _CurriedRem2<R, T1, T2> extends TypeFunction1<R, T2> {
  final TypeFunction2<R, T1, T2> _src;
  final T1 _a1;
  _CurriedRem2(this._src, this._a1);
  @override
  R call(T2 a2) => _src.call(_a1, a2);
}

TypeFunction1<TypeFunction1<R, T2>, T1> curry2<R, T1, T2>(
        TypeFunction2<R, T1, T2> f) =>
    _Curried2<R, T1, T2>(f);
