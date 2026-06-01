import 'package:dart2cpp/restorer/runtime_classes.dart';

void main() {
  var xs = StaticList<int>.of3(1, 2, 3);
  staticPrint(xs[1]);
}
