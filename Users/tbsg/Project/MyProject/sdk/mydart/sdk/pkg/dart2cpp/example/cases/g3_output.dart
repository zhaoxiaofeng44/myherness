import 'package:dart2cpp/runtime/type_function.dart';

class Counter {
  int offset;
  Counter(this.offset);
  int handle(int x) => x + offset;
}

void main() {
  final c = Counter(10);
  final h = _TearOff_Counter_handle(c);
  print(h(5));
}

// --- dart2cpp synthesised TypeFunction subclasses ---

class _TearOff_Counter_handle extends TypeFunction1<int, int> {
  final Counter _r;
  _TearOff_Counter_handle(this._r);
  @override
  int call(int a1) => _r.handle(a1);
}
