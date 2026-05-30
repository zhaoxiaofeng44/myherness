import 'cases/c2_output.dart' as m;

void main() {
  final adder = m.make(10);
  print(adder(5)); // expect 15
}
