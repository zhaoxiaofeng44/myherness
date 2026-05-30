# 任务：让转换后的代码里 0 处 Function 残留（含 tear-off / 函数值表达式）

## 背景
迭代 1 已经做到：
- `R Function(T1, T2)` 等**类型注解**会被改写成 `TypeFunctionN<R, T1, T2>`；
- **闭包字面量**会被提升为 `_Closure_N extends TypeFunctionN<...>`；
- `print` 通过一个极小的内置 `_tearOffRegistry` 被包成 `_TearOff_print`；
- 出口禁令 pass 会抓住任何 `NamedType('Function')` 或 `SimpleIdentifier('Function')`。

漏点（也就是这一轮要补的）：
1. **任意 tear-off**：`var f = max;`、`var g = int.parse;`、`var cb = obj.handle;` 等，源文本里没有 `Function` 字面量，禁令出口抓不住，但实际产物里 `f`/`g`/`cb` 的运行时类型仍是 `Function` 子类型。
2. **参数位置的 tear-off**：`[1,2,3].forEach(print)` —— 当前 Pass 4 只看 `VariableDeclaration.initializer`，看不到 `ArgumentList` 里的 tear-off。
3. **实例方法 tear-off**：要把 receiver 作为 `final` 字段捕获到生成类里。
4. **泛型 tear-off**：`max` 是 `T Function<T extends num>(T, T)`，不能无歧义实例化为某个 `TypeFunctionN<...>`，需要显式失败而不是悄悄留下。

## 我们要做的事
1. 把 Pass 4 从「纯语法 + 注册表查找」升级到「基于已解析 AST（resolved AST）」：
   - 用 `AnalysisContextCollection` + `getResolvedUnit` 拿到带类型信息的 AST。
   - 遍历所有 `Expression`，对每个 `staticType is FunctionType` 且不在调用位（不是 `MethodInvocation.function/target`，也不是 `FunctionExpressionInvocation.function`）的节点做处理。
2. 按 element 类型生成对应的 TypeFunctionN 包装：
   - **顶层函数**（`TopLevelFunctionElement` / `FunctionElement`）→ `_TearOff_<name>`，无捕获；
   - **静态方法**（`MethodElement` 且 `isStatic`）→ `_TearOff_<class>_<name>`，无捕获；
   - **实例方法**（`MethodElement` 非静态）→ `_TearOff_<class>_<name>`，捕获 receiver；
   - **构造函数 tear-off**（`ConstructorElement`）→ `_TearOff_<class>_ctor[_<name>]`；
   - **闭包字面量**（`FunctionExpression`）→ 沿用现有 `_Closure_N`，但参数/返回类型直接从已解析的 `staticType` 拿。
3. 同 element 多次出现 → **共用一个**生成类（按 element 去重，否则文件会膨胀）。
4. 泛型 tear-off / 复杂表达式（不是 `Identifier` / `PrefixedIdentifier` / `PropertyAccess` 而 `staticType` 又是 `FunctionType`）→ **失败并指源位**，不留隐患。
5. Pipeline 重排：Pass 4（resolved，吃文件路径）→ Pass 3（语法，吃字符串）→ Pass 6（语法，吃字符串）。Pass 3 和 Pass 6 不动语义。

## 最终目标（可验证）
- 跑转换器把下列任何一种输入转换后，输出文件里 `grep -nE '\bFunction\b' | grep -v TypeFunction` **零命中**，且 `dart analyze` 干净：
  - 顶层函数 tear-off：`var f = someTopLevelFn;`
  - 静态方法 tear-off：`var p = MyClass.staticMethod;`
  - 实例方法 tear-off：`var h = obj.handle;`（receiver 必须被捕获）
  - 参数位置 tear-off：`[1,2,3].forEach(print);`
  - 同一 element 出现多次（共用一个生成类，不重复生成）
- 泛型 tear-off（如 `var f = max;`，`max: T Function<T extends num>(T, T)`）→ 转换器以非零码退出，错误信息包含源 `path:line:col` 与"无法实例化泛型 tear-off"字样。
- 非 tear-off 的函数值表达式（例如 `var f = condition ? print : someOther;`）→ 同样以非零码退出并指位，提示用户改写源码。
- 迭代 1 的全部 14 条测试**不回归**，仍全部 PASS。
- 新增至少 5 条针对 tear-off / 实例捕获 / 泛型拒绝 / 参数位置 / 去重 的验证项，逐条 PASS/FAIL。
