int Function(int) make(int seed) {
  return (int x) => x + seed;
}

void main() {
  final adder = make(10);
  adder(5);
}
