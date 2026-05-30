import 'package:dart2cpp/runtime/type_function.dart';

TypeFunction1<int, int> make(int seed) {
  return _Closure_1(seed);
}

void main() {
  final adder = make(10);
  adder(5);
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _Closure_1 extends TypeFunction1<int, int> {
  final int seed;
  _Closure_1(this.seed);
  @override
  int call(int x) => x + seed;
}
