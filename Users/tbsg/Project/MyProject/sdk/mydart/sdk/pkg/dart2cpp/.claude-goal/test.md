# 验证清单（迭代 2）

每一条都能独立判定 PASS / FAIL。除非特别说明，命令都在 `pkg/dart2cpp/` 目录下执行。
A/B/C/D/E/F 组是迭代 1 的红线（必须不回归）；G 组是这一轮新增。

## A. 运行时模块自身

- [ ] **A1 — TypeFunction 基类编译通过**
  - 命令：`dart analyze lib/runtime/type_function.dart`
  - PASS：无 error、无 warning。

- [ ] **A2 — arity 0..N 子类齐全**
  - 命令：`dart run tool/check_arities.dart`
  - PASS：脚本退出码 0。

- [ ] **A3 — 文档里出现 `TypeFunction<R, T...>` 统一记法**
  - 手动：`lib/runtime/type_function.dart` 顶部注释。
  - PASS：注释存在且语义清晰。

## B. 类型注解改写（Pass 3）

- [ ] **B1 — `void Function()` → `TypeFunction0<void>`**（命令同迭代 1）
- [ ] **B2 — `R Function(T1, T2)` → `TypeFunction2<R, T1, T2>`**
- [ ] **B3 — 裸 `Function` 触发显式报错**（含「cannot infer arity」措辞）

## C. 闭包 / 字面量 / tear-off（旧）

- [ ] **C1 — 函数字面量被提升为 TypeFunctionN 子类**
- [ ] **C2 — 捕获自由变量正确保留**（`make(10)(5) == 15` 实跑过）
- [ ] **C3 — tear-off 被包成 TypeFunctionN 实例**（旧 `var p = print;` 用例）

## D. 包装方法（Pass 5）

- [ ] **D1 — `lib/src/wrappers/` 内禁出现 `Function`**
- [ ] **D2 — 包装器签名以 TypeFunctionN 暴露**

## E. 禁令校验出口（Pass 6）

- [ ] **E1 — 故意残留 `Function` 时出口报错**
- [ ] **E2 — 注释 / 字符串里的 "Function" 一词不被误伤**

## F. 端到端样例

- [ ] **F1 — sample_input → sample_output**（`diff -u` 无差异）
- [ ] **F2 — 转换产物里 0 处 `Function`**

## G. tear-off 全覆盖（新增 — 迭代 2 重点）

- [ ] **G1 — 顶层函数 tear-off 在赋值位**
  - 输入：`example/cases/g1_toplevel_tearoff_var.dart`，含 `int twice(int x) => x * 2; var f = twice;`
  - 命令：`dart run bin/dart2cpp.dart example/cases/g1_toplevel_tearoff_var.dart -o /tmp/g1.dart`
  - PASS：
    - 输出文件含一个 `class _TearOff_twice extends TypeFunction1<int, int>`；
    - `f = const _TearOff_twice()`（或等价的实例化）；
    - `grep -nE '\bFunction\b' /tmp/g1.dart | grep -v TypeFunction` 无输出；
    - `dart analyze /tmp/g1.dart` 无问题（需把文件搬到 `example/cases/g1_output.dart` 才能解析 import）。
  - FAIL：`twice` 在 `f = ...` 中原样保留；或类未生成；或残留 `Function`。

- [ ] **G2 — 静态方法 tear-off**
  - 输入：`example/cases/g2_static_tearoff.dart`，含一个有 `static int dbl(int x) => x * 2;` 的类，`var f = MyClass.dbl;`
  - PASS：输出含 `class _TearOff_MyClass_dbl extends TypeFunction1<int, int>` 且 `f = const _TearOff_MyClass_dbl()`，无残留 `Function`。

- [ ] **G3 — 实例方法 tear-off（receiver 必须捕获）**
  - 输入：`example/cases/g3_instance_tearoff.dart`，含
    ```dart
    class Counter {
      int offset;
      Counter(this.offset);
      int handle(int x) => x + offset;
    }
    void main() {
      final c = Counter(10);
      final h = c.handle;
      print(h(5)); // expect 15
    }
    ```
  - PASS：
    - 生成 `class _TearOff_Counter_handle extends TypeFunction1<int, int>`，且**有** `final Counter _r;`、构造器 `_TearOff_Counter_handle(this._r)`、`call(int x) => _r.handle(x)`；
    - `h = _TearOff_Counter_handle(c)`；
    - 把输出落到 `example/cases/g3_output.dart` 后 `dart run example/cases/g3_output.dart` 真实输出 `15`。
  - FAIL：receiver 被丢；或 `h` 仍指向裸 `c.handle`；或运行结果 ≠ 15。

- [ ] **G4 — 参数位置 tear-off**
  - 输入：`example/cases/g4_arg_tearoff.dart`，含 `[1,2,3].forEach(print);`
  - PASS：参数 `print` 在输出中被换成 `const _TearOff_print()`（或等价）；产物 `dart analyze` 干净；无残留 `Function`。
  - FAIL：参数仍是裸 `print`。

- [ ] **G5 — 泛型 tear-off 必须报错（不能悄悄放过）**
  - 输入：`example/cases/g5_generic_reject.dart`，含 `import 'dart:math'; var f = max;`
  - PASS：转换器以非零码退出，错误信息包含源 `g5_generic_reject.dart:行:列` 与「无法实例化泛型 tear-off」字样。
  - FAIL：静默通过；或报错不指源位置；或报错语义不清。

- [ ] **G6 — 同一 element 出现多次只生成一个类**
  - 输入：`example/cases/g6_dedup.dart`，同一个顶层函数 tear-off 在两个不同位置出现。
  - PASS：输出里 `_TearOff_xxx` 的 `class` 定义**恰好一次**（`grep -c '^class _TearOff_'` == 期望值，对应该用例 1）。
  - FAIL：每出现一次就生成一个新类。

- [ ] **G7 — 回归红线：迭代 1 全部样例仍通过**
  - 命令：对 `example/cases/b1..e2`、`example/sample_input.dart` 逐个跑一次 `dart run bin/dart2cpp.dart …`，并对 `example/sample_input.dart` 做 `diff -u example/sample_output.dart /tmp/sample_actual.dart`。
  - PASS：所有命令的退出码与迭代 1 评估时一致（错误用例非零、正确用例零、diff 为空）。
  - FAIL：任意一项行为发生变化。
