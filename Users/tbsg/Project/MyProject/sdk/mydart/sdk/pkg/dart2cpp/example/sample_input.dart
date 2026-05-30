int Function(int, int) add = (int a, int b) => a + b;

int Function(int) make(int seed) {
  return (int x) => x + seed;
}

var p = print;

void main() {
  add(2, 3);
  final adder = make(10);
  adder(5);
  p('hello');
}
