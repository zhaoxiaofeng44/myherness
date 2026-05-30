import 'dart:math';

var fMax = max;
var fParse = int.parse;

void apply(int Function(int) f) {
  f(3);
}

void main() {
  [1, 2, 3].forEach(print);
}
