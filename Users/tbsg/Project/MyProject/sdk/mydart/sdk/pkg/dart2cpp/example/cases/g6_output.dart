import 'package:dart2cpp/restorer/runtime_classes.dart';
import 'package:dart2cpp/runtime/type_function.dart';

int twice(int x) => x * 2;

void main() {
  final f = const _TearOff_twice();
  final g = const _TearOff_twice();
  staticPrint(f(2) + g(3));
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _TearOff_twice extends TypeFunction1<int, int> {
  const _TearOff_twice();
  @override
  int call(int a1) => twice(a1);
}
