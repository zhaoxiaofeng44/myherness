import 'package:dart2cpp/restorer/runtime_classes.dart';
import 'package:dart2cpp/runtime/type_function.dart';

class MyClass {
  static int dbl(int x) => x * 2;
}

void main() {
  var f = const _TearOff_MyClass_dbl();
  staticPrint(f(7));
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _TearOff_MyClass_dbl extends TypeFunction1<int, int> {
  const _TearOff_MyClass_dbl();
  @override
  int call(int a1) => MyClass.dbl(a1);
}
