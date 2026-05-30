int twice(int x) => x * 2;

void main() {
  final f = twice;
  final g = twice;
  print(f(2) + g(3));
}
