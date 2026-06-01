import 'package:dart2cpp/restorer/runtime_classes.dart';
import 'package:dart2cpp/runtime/type_function.dart';

void main() {
  StaticList<int>.of3(1, 2, 3).forEach(const _TearOff_staticPrint_void_int());
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _TearOff_staticPrint_void_int extends TypeFunction1<void, int> {
  const _TearOff_staticPrint_void_int();
  @override
  void call(int a1) => staticPrint(a1);
}
