class Counter {
  int offset;
  Counter(this.offset);
  int handle(int x) => x + offset;
}

void main() {
  final c = Counter(10);
  final h = c.handle;
  print(h(5));
}
