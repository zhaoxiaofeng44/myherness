import 'package:dart2cpp/runtime/type_function.dart';

int twice(int x) => x * 2;

void main() {
  var f = const _TearOff_twice();
  print(f(7));
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _TearOff_twice extends TypeFunction1<int, int> {
  const _TearOff_twice();
  @override
  int call(int a1) => twice(a1);
}
