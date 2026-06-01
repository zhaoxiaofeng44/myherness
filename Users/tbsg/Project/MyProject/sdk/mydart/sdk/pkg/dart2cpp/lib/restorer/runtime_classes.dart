// Restorer runtime — the only API surface business code is allowed to touch
// when reaching for dart:core capabilities. dart2cpp Pass 7 rewrites every
// `print` / `List` literal / `Iterable.forEach` access in user source into a
// call against the symbols declared in this file. Pass 6 (forbid_function)
// whitelists this file: it is the *only* place where bare `List`, `print`,
// and other dart:core identifiers are allowed to appear post-conversion.

import 'package:dart2cpp/runtime/type_function.dart';

void staticPrint(Object? msg) => print(msg);

class StaticList<T> {
  final List<T> _l;
  const StaticList._(this._l);

  factory StaticList.of0() => StaticList<T>._(<T>[]);
  factory StaticList.of1(T a) => StaticList<T>._(<T>[a]);
  factory StaticList.of2(T a, T b) => StaticList<T>._(<T>[a, b]);
  factory StaticList.of3(T a, T b, T c) => StaticList<T>._(<T>[a, b, c]);
  factory StaticList.of4(T a, T b, T c, T d) =>
      StaticList<T>._(<T>[a, b, c, d]);
  factory StaticList.of5(T a, T b, T c, T d, T e) =>
      StaticList<T>._(<T>[a, b, c, d, e]);
  factory StaticList.of6(T a, T b, T c, T d, T e, T f) =>
      StaticList<T>._(<T>[a, b, c, d, e, f]);
  factory StaticList.of7(T a, T b, T c, T d, T e, T f, T g) =>
      StaticList<T>._(<T>[a, b, c, d, e, f, g]);
  factory StaticList.of8(T a, T b, T c, T d, T e, T f, T g, T h) =>
      StaticList<T>._(<T>[a, b, c, d, e, f, g, h]);

  int get length => _l.length;
  T operator [](int i) => _l[i];
  void operator []=(int i, T v) => _l[i] = v;
  void add(T v) => _l.add(v);
  void forEach(TypeFunction1<void, T> f) {
    for (final e in _l) f(e);
  }
}
