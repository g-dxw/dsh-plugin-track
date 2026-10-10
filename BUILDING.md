# 对应源码与构建

本 tgz 中的 src/、tests/、构建与测试配置、校验脚本及锁文件对应已提交的发行源码。SOURCE-SNAPSHOT.json 记录随包源码的实际字节、SHA-256 与构建提交；编译产物 lib/index.js 和 lib/client.js 由这些源码构建。npm 自动排除根目录 yarn.lock，因此随包锁文件保存在 build-inputs/yarn.lock。

使用 package.json engines 指定的 Node 版本和 Yarn 4.18.0：

~~~powershell
Copy-Item -LiteralPath build-inputs/yarn.lock -Destination yarn.lock
corepack yarn install --immutable --mode=skip-build
corepack yarn typecheck
corepack yarn build
npm test -- --maxWorkers=2
npm run test:release
~~~

## GitHub Actions

.github/workflows/ci.yml 在 push、Pull Request 和发行调用时执行安装、类型检查、构建、测试和 npm 打包。源码提交干净后，generate-source-snapshot.mjs 根据 npm 实际发布清单刷新 SOURCE-SNAPSHOT.json 和 package.json 的 trackSource；生成字段不要求写回 Git。快照使用当前 runner 的真实文件字节，所以 Windows 与 Linux 的文本换行差异不会导致错误的归档哈希。

CI 上传 tgz、npm-pack.json、SHA256SUMS 和 package-verification.json。verify-package.mjs 直接读取 tgz，核对完整源码清单、每个文件的大小和哈希、包身份、构建入口和插件注册文件；不会把归档解包到文件系统。

.github/workflows/publish.yml 在 v* tag 推送或手动选择已有 tag 时调用同一构建流程，下载和复核同一个 tgz，再发布到 npm。稳定版本使用 latest，预发行版本使用 beta；不会为了发布重新打包。

推荐在 npm 的包设置中配置 Trusted Publisher：GitHub owner 为 g-dxw，repository 为 dsh-plugin-track，workflow filename 为 publish.yml，并允许直接 npm publish。GitHub 托管 runner 通过 OIDC 获取短期发布授权，无需长期 npm token。手动运行可显式选择 token 方式，使用仓库 Secret NPM_TOKEN；默认采用 OIDC。实际发布仍需 npm 侧的授权已配置。

## 发布包检查

在干净的已提交源码上完成构建与测试后，可执行：

~~~powershell
node scripts/generate-source-snapshot.mjs
npm pack --ignore-scripts --json --pack-destination outputs
node scripts/verify-package.mjs outputs/cqai-dsh-plugin-track-0.1.3.tgz
~~~

package.json、SOURCE-SNAPSHOT.json 及 lib/ 为清单中的派生或自引用项，由 tgz 的整体 SHA-256、SHA-512 integrity 和 npm provenance 标识。CI 生成的包以 Actions 下载的校验报告为准。

运行时宿主通过 cordis.patch.yml 注册插件。原始轨迹、照片、用户 Profile、缓存、输出视频和登录凭据均不在发布白名单中。

外部依赖的完整许可与源码取得方式见 [第三方声明](THIRD_PARTY_NOTICES.md)；GeoMotion 来源与分发记录见 [SOURCE.md](src/track/vendor/geomotion/SOURCE.md)。
