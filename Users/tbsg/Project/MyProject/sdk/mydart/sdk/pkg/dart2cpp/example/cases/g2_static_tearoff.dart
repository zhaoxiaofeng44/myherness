class MyClass {
  static int dbl(int x) => x * 2;
}

void main() {
  var f = MyClass.dbl;
  print(f(7));
}
