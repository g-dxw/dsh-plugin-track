# 对应源码与构建

本 tgz 中的 src/、tests/、构建与测试配置、校验脚本及锁文件对应本次完整、已提交并合并的发行源码。SOURCE-SNAPSHOT.json 记录发行文件的 SHA-256 与源码基线，编译产物 lib/index.js 和 lib/client.js 由这些源码构建。npm 自动排除根目录 yarn.lock，因此随包锁文件保存在 build-inputs/yarn.lock。

使用 package.json engines 指定的 Node 版本和 Yarn 4.18.0：

~~~powershell
Copy-Item -LiteralPath build-inputs/yarn.lock -Destination yarn.lock
corepack yarn install --immutable --mode=skip-build
corepack yarn typecheck
corepack yarn build
npm test -- --maxWorkers=2
~~~

运行时宿主通过 cordis.patch.yml 注册插件。原始轨迹、照片、用户 Profile、缓存、输出视频和登录凭据均不在发布白名单中。

外部依赖的完整许可与源码取得方式见 [第三方声明](THIRD_PARTY_NOTICES.md)；GeoMotion 来源与分发记录见 [SOURCE.md](src/track/vendor/geomotion/SOURCE.md)。
