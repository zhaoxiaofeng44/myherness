import 'package:dart2cpp/restorer/runtime_classes.dart';
import 'package:dart2cpp/runtime/type_function.dart';

TypeFunction2<int, int, int> add = _Closure_1();

TypeFunction1<int, int> make(int seed) {
  return _Closure_2(seed);
}

var p = const _TearOff_staticPrint();

void main() {
  add(2, 3);
  final adder = make(10);
  adder(5);
  p('hello');
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _Closure_1 extends TypeFunction2<int, int, int> {
  _Closure_1();
  @override
  int call(int a, int b) => a + b;
}

class _Closure_2 extends TypeFunction1<int, int> {
  final int seed;
  _Closure_2(this.seed);
  @override
  int call(int x) => x + seed;
}

class _TearOff_staticPrint extends TypeFunction1<void, Object?> {
  const _TearOff_staticPrint();
  @override
  void call(Object? a1) => staticPrint(a1);
}
