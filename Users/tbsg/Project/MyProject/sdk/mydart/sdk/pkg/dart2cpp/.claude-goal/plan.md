# 实施计划（迭代 2 — 全覆盖 tear-off）

> 起点：迭代 1 的代码骨架完整保留（`lib/runtime/type_function.dart`、`lib/src/passes/{rewrite_function_type,rewrite_closure,forbid_function}.dart`、`lib/src/wrappers/*`、`bin/dart2cpp.dart`、`lib/src/pipeline.dart`、`example/cases/*`、`test.md`）。
> 这一轮**替换** Pass 4，**不动** Pass 3 / Pass 6 / runtime / wrappers / CLI 入口的对外行为。

## 第 1 步：在 pipeline 里把 Pass 4 提到最前面，并改成「吃文件路径」
- 文件：`lib/src/pipeline.dart`
- 改动：
  - `convertSource(path, source)` 重命名为内部用；对外暴露 `convertFile(inputPath, outputPath)` 作为主入口。
  - 顺序改为：Pass 4（resolved，吃 path）→ Pass 3（syntactic，吃 string）→ Pass 6（syntactic，吃 string）。
  - Pass 4 完成后把改写后的源码写入一个临时同名文件，传给 Pass 3 时按字符串处理即可。
- 为什么：Pass 4 需要类型解析，类型解析需要文件存在于 pub 包上下文里；Pass 3 / Pass 6 是纯语法，不挑路径。
- 风险：解析必须以**异步**入口拿（`getResolvedUnit` 返回 `Future`）。CLI 主函数要 `async`，整条 pipeline 也要 `async`。

## 第 2 步：新 Pass 4 —— `lib/src/passes/rewrite_function_values.dart`
> 顺序上要在 Pass 3 之前跑，所以**不**复用 `rewrite_closure.dart` 的名字；新建一个文件，旧文件先留着，等新 pass 跑通再删。

- 入口：`Future<String> rewriteFunctionValues(String inputPath)`，返回改写后的源字符串。
- 实现要点：
  1. 用 `AnalysisContextCollection(includedPaths: [absPath])` + `contextFor(absPath).currentSession.getResolvedUnit(absPath)` 拿 `ResolvedUnitResult`。
  2. 遍历 `unit.visitChildren(_FnValueVisitor(...))`。
  3. 访问以下 AST 节点：
     - `SimpleIdentifier` / `PrefixedIdentifier` / `PropertyAccess` —— 候选 tear-off。
     - `FunctionExpression` —— 闭包字面量。
  4. 对每个候选节点判定：
     - 跳过：在声明位、在 `MethodInvocation.methodName` 且 `target == null`、在 `MethodInvocation.target/realTarget`（只是 receiver）、在 `FunctionExpressionInvocation.function` 内但本节点是被调用的整体不是这里要处理的"函数值"形式 …… 收集一套清晰的 skip 规则放函数里集中判断。
     - `node.staticType is! FunctionType` → 跳过（说明它根本不是函数值）。
     - `staticType` 是 `FunctionType` 但 `typeFormals.isNotEmpty`（泛型函数） → `ConversionError` 报「无法实例化泛型 tear-off：缺少类型实参」并附源位置。
     - 已经是 `TypeFunction*` 实例（element 是 ClassElement 名字以 `TypeFunction` 开头） → 跳过。
     - 其余 → 生成包装。

- 包装生成规则：
  - 顶层函数 / 静态方法（无 receiver）：
    ```dart
    class _TearOff_<safeName> extends TypeFunction<arity>< R, T1, ... > {
      const _TearOff_<safeName>();
      @override R call(T1 a1, ...) => <qualifiedCall>(a1, ...);
    }
    ```
    然后把原节点整体替换为 `const _TearOff_<safeName>()`。
  - 实例方法：
    ```dart
    class _TearOff_<class>_<method> extends TypeFunction<arity>< R, T... > {
      final <ReceiverType> _r;
      _TearOff_<class>_<method>(this._r);
      @override R call(T1 a1, ...) => _r.<method>(a1, ...);
    }
    ```
    原节点（`obj.method`）替换为 `_TearOff_<class>_<method>(obj)`。注意 `obj` 表达式如果有副作用要先求值；先按"`obj` 是简单 Identifier/Prefix"实现，遇到复杂表达式直接报错指位（后续可扩展）。
  - 构造函数 tear-off（`new Foo` / `Foo.named`）：先按「同顶层」处理，`call` 内部 `=> Foo(a1, ...)` 或 `=> Foo.named(a1, ...)`。
  - 闭包字面量：和迭代 1 等价，但参数/返回类型直接从 `FunctionExpression.staticType` 拿（`FunctionType.returnType` / `FunctionType.normalParameterTypes`），不再依赖外层注解；捕获自由变量的实现保持迭代 1 的思路（按名字匹配 enclosing scope）。

- 去重：用一个 `Map<Element, String>`（key=tear-off 所指 element），首次出现时记录生成的类名并 `appended` 一份；后续命中直接复用类名，跳过追加。

- 错误路径：每条错误都通过 `ConversionError(path, line, col, message)` 抛出，消息里必须有：源 `path:line:col` + 一句话原因 + 可操作的修复建议。

## 第 3 步：删掉旧 Pass 4
- 文件：`lib/src/passes/rewrite_closure.dart`
- 行为：等新 Pass 4 在所有迭代 1 测试上跑通后删除；pipeline 不再 import。
- 风险：删早了会让 iteration 1 测试瞬间挂；删 timing 必须在第 4 步之后。

## 第 4 步：补充测试用例输入文件
- `example/cases/g1_toplevel_tearoff_var.dart` —— `int twice(int x) => x * 2; var f = twice;` + `main` 里 `f(3)`。
- `example/cases/g2_static_tearoff.dart` —— 一个含 `static int double(int x) => x * 2;` 的类，`var f = MyClass.double;`。
- `example/cases/g3_instance_tearoff.dart` —— 一个有实例方法 `int handle(int x) => x + offset;` 的类，外面 `var h = obj.handle;`，验证 receiver 捕获。
- `example/cases/g4_arg_tearoff.dart` —— `[1,2,3].forEach(print);`，验证参数位置包装。
- `example/cases/g5_generic_reject.dart` —— `import 'dart:math'; var f = max;`，期望报错指位。
- `example/cases/g6_dedup.dart` —— 同一 tear-off 出现两次，确认只生成一个 `_TearOff_xxx` 类。

## 第 5 步：扩 `.claude-goal/test.md`
- 在原 14 条后追加 G 组 6 条（对应上面 6 个 input），每条独立 PASS/FAIL。
- A/B/C/D/E/F 全部保留并要求继续 PASS（回归红线）。

## 不确定点 / 待动手时确认
- **analyzer 13 的 element / type API**：`element` 是 `Element` 还是 `Element2`、`FunctionType.typeFormals` 是否还叫这个名字、`TopLevelFunctionElement` 是否存在 —— 写代码时第一时间 `dart analyze` 校准。
- **第三方包导入**：测试输入只用 `dart:core` / `dart:math` / `dart:async`，避免 `AnalysisContextCollection` 拉外部包让解析变慢。
- **首次解析延迟**：本地实测可能从 ~0.3s 飙到 ~3s。可以接受，但要在 task.md / README 里提一句。
- **同一文件中 tear-off 与同名局部变量冲突**（如局部 `final print = ...` 后又 `someFn(print)`）—— 第 1 轮不处理，遇到时按"element 不是 ExecutableElement"自然 fallthrough。
