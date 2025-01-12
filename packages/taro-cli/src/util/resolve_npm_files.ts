import * as fs from 'fs-extra'
import * as path from 'path'
import * as resolvePath from 'resolve'
import * as wxTransformer from '@tarojs/transformer-wx'
import * as babel from 'babel-core'
import * as t from 'babel-types'
import traverse from 'babel-traverse'
import generate from 'babel-generator'
import * as _ from 'lodash'

import {
  isNpmPkg,
  promoteRelativePath,
  printLog,
  recursiveFindNodeModules,
  generateEnvList,
  isQuickappPkg,
  generateAlipayPath
} from './index'

import {
  processTypeEnum,
  REG_TYPESCRIPT,
  BUILD_TYPES,
  REG_STYLE,
  REG_FONT,
  REG_IMAGE,
  REG_MEDIA,
  REG_JSON,
  taroJsFramework,
  NODE_MODULES_REG,
  taroJsRedux,
  taroJsMobxCommon,
  taroJsMobx
} from './constants'

import defaultUglifyConfig from '../config/uglify'

import * as npmProcess from './npm'
import { IInstallOptions, INpmConfig, IResolvedCache, TogglableOptions, ITaroManifestConfig } from './types'
import { convertArrayToAstExpression, convertObjectToAstExpression } from './astConvert'

const excludeNpmPkgs = ['ReactPropTypes']

const resolvedCache: IResolvedCache = {}
const copyedFiles = {}
const excludeReplaceTaroFrameworkPkgs = new Set([taroJsRedux, taroJsMobx, taroJsMobxCommon])

const nodeLibMaps = { // 替换node库
  'crypto': 'crypto-browserify',
  'stream': 'stream-browserify',
  'vm': 'vm-browserify'
}
const nodeFileMaps = {} // 映射的lib文件
export function resolveNpmPkgMainPath(
  pkgName: string,
  isProduction: boolean,
  npmConfig: INpmConfig,
  buildAdapter: BUILD_TYPES = BUILD_TYPES.WEAPP,
  root: string
) {
  try {
    if (nodeLibMaps[pkgName]) {
      pkgName = nodeLibMaps[pkgName]
    }
    let rPkgName = pkgName
    if (pkgName.indexOf('/') === -1) {
      rPkgName += '/' // 强制使用node_modules下的库
    }
    const res = {
      main: '',
      alias: {}
    }
    res.main = resolvePath.sync(rPkgName, {
      basedir: root,
      packageFilter: (pkg, pkgDir) => { // 支持browser入口
        if (pkg.browser) {
          if (typeof pkg.browser === 'string') {
            pkg.main = pkg.browser;
            delete pkg.browser;
          } else {
            for (const bf in pkg.browser) {
              const relativeBf = path.relative('.', bf)
              const realBf = pkg.browser[bf]
              if (relativeBf === 'index.js') {
                pkg.main = realBf
              } else {
                const k = path.resolve(pkgDir, bf)
                res.alias[k] = typeof realBf === 'string' ? path.resolve(pkgDir, pkg.browser[bf]) : realBf;
                // TODO 'util': false 这种情况
                nodeFileMaps[k] = res.alias[k]
              }
            }
          }
        }
        return pkg;
      }
    })
    // 替换main
    const dirName = path.resolve(root, pkgName)
    if (nodeFileMaps[dirName] === false) { // 表示忽略,使用taro替换
      res.main = resolvePath.sync('@tarojs/taro', { basedir: root })
    } else if (nodeFileMaps[res.main] != null) {
      res.main = nodeFileMaps[res.main]
    }
    return res
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      if (resolvePath.isCore(pkgName)) {
        console.log(`缺少node核心包${pkgName}，请手动修复！`)
        return { main: '' }
      }
      console.log(`缺少npm包${pkgName}，开始安装...`)
      const installOptions: IInstallOptions = {
        dev: false
      }
      if (pkgName.indexOf(npmProcess.taroPluginPrefix) >= 0) {
        installOptions.dev = true
      }
      npmProcess.installNpmPkg(pkgName, installOptions)
      return resolveNpmPkgMainPath(pkgName, isProduction, npmConfig, buildAdapter, root).main
    }
  }
}

export function resolveNpmFilesPath({
                                      pkgName,
                                      isProduction,
                                      npmConfig,
                                      buildAdapter,
                                      root,
                                      rootNpm,
                                      npmOutputDir,
                                      compileConfig = {},
                                      env,
                                      uglify,
                                      babelConfig,
                                      quickappManifest
                                    }: {
  pkgName: string,
  isProduction: boolean,
  npmConfig: INpmConfig,
  buildAdapter: BUILD_TYPES,
  root: string,
  rootNpm: string,
  npmOutputDir: string,
  compileConfig: { [k: string]: any },
  env: object,
  uglify: TogglableOptions,
  babelConfig: object,
  quickappManifest?: ITaroManifestConfig
}) {
  if (!resolvedCache[pkgName]) {
    const res = resolveNpmPkgMainPath(pkgName, isProduction, npmConfig, buildAdapter, root)
    res.files = []
    resolvedCache[pkgName] = res
    resolvedCache[pkgName].files.push(res.main)
    compileConfig.alias = res.alias
    recursiveRequire({
      filePath: res.main,
      files: resolvedCache[pkgName].files,
      isProduction,
      npmConfig,
      buildAdapter,
      rootNpm,
      npmOutputDir: npmOutputDir,
      compileConfig,
      env,
      uglify,
      babelConfig,
      quickappManifest
    })
  }
  return resolvedCache[pkgName]
}

function analyzeImportUrl({
                            requirePath,
                            excludeRequire,
                            source,
                            filePath,
                            files,
                            isProduction,
                            npmConfig,
                            rootNpm,
                            npmOutputDir,
                            buildAdapter,
                            compileConfig = [],
                            env,
                            uglify,
                            babelConfig,
                            quickappManifest
                          }: {
  requirePath: string,
  excludeRequire: string[],
  source: any,
  filePath: string,
  files: string[],
  isProduction: boolean,
  npmConfig: INpmConfig,
  rootNpm: string,
  npmOutputDir: string,
  buildAdapter: BUILD_TYPES,
  compileConfig: { [k: string]: any },
  env: object,
  uglify: TogglableOptions,
  babelConfig: object,
  quickappManifest?: ITaroManifestConfig
}) {
  if (excludeRequire.indexOf(requirePath) < 0) {
    const quickappPkgs = quickappManifest ? quickappManifest.features : []
    if (buildAdapter === BUILD_TYPES.QUICKAPP && isQuickappPkg(requirePath, quickappPkgs)) {
      return
    }
    if (isNpmPkg(requirePath)) {
      if (excludeNpmPkgs.indexOf(requirePath) < 0) {
        const taroMiniAppFramework = `@tarojs/taro-${buildAdapter}`
        excludeReplaceTaroFrameworkPkgs.add(taroMiniAppFramework)
        if (requirePath === taroJsFramework
          && (!NODE_MODULES_REG.test(filePath) || !Array.from(excludeReplaceTaroFrameworkPkgs).some(item => filePath.replace(/\\/g, '/').indexOf(item) >= 0))) {
          requirePath = taroMiniAppFramework
        }
        const res = resolveNpmFilesPath({
          pkgName: requirePath,
          isProduction,
          npmConfig,
          buildAdapter,
          root: path.dirname(recursiveFindNodeModules(filePath)),
          rootNpm,
          npmOutputDir,
          compileConfig,
          env,
          uglify,
          babelConfig,
          quickappManifest
        })
        let relativeRequirePath = promoteRelativePath(path.relative(filePath, res.main))
        relativeRequirePath = relativeRequirePath.replace(/node_modules/g, npmConfig.name)
        if (buildAdapter === BUILD_TYPES.ALIPAY) {
          relativeRequirePath = generateAlipayPath(relativeRequirePath)
        }
        source.value = relativeRequirePath
      }
    } else {
      let realRequirePath = path.resolve(path.dirname(filePath), requirePath)
      const checkAlias = () => {
        if (nodeFileMaps.hasOwnProperty(realRequirePath)) {
          const toPath = nodeFileMaps[realRequirePath]
          if (typeof toPath === 'string') {
            realRequirePath = toPath
            requirePath = './' + promoteRelativePath(path.relative(path.dirname(filePath), realRequirePath))
          } else {
            requirePath = '@tarojs/taro'
            realRequirePath = path.resolve(rootNpm, '@tarojs/taro')
          }
        }
        return realRequirePath
      }

      const tempPathWithJS = `${realRequirePath}.js`
      const tempPathWithIndexJS = `${realRequirePath}${path.sep}index.js`
      if (fs.existsSync(tempPathWithJS)) {
        realRequirePath = tempPathWithJS
        requirePath += '.js'
        checkAlias()
      } else if (fs.existsSync(tempPathWithIndexJS)) {
        realRequirePath = tempPathWithIndexJS
        requirePath += '/index.js'
        checkAlias()
      }
      if (files.indexOf(realRequirePath) < 0) {
        files.push(realRequirePath)
        recursiveRequire({
          filePath: realRequirePath,
          files,
          isProduction,
          npmConfig,
          buildAdapter,
          rootNpm,
          npmOutputDir,
          compileConfig,
          env,
          uglify,
          babelConfig,
          quickappManifest
        })
      }
      source.value = requirePath
    }
  }
}

function parseAst({
                    ast,
                    filePath,
                    files,
                    isProduction,
                    npmConfig,
                    rootNpm,
                    npmOutputDir,
                    buildAdapter,
                    compileConfig = {},
                    env,
                    uglify,
                    babelConfig,
                    quickappManifest
                  }: {
  ast: t.File,
  filePath: string,
  files: string[],
  isProduction: boolean,
  npmConfig: INpmConfig,
  rootNpm: string,
  npmOutputDir: string,
  buildAdapter: BUILD_TYPES,
  compileConfig: { [k: string]: any },
  env: object,
  uglify: TogglableOptions,
  babelConfig: object,
  quickappManifest?: ITaroManifestConfig
}) {
  const excludeRequire: string[] = []

  traverse(ast, {
    IfStatement(astPath) {
      astPath.traverse({
        BinaryExpression(astPath) {
          const node = astPath.node
          const left = node.left
          const right = node.right
          if (t.isMemberExpression(left) && t.isStringLiteral(right)) {
            if (generate(left).code === 'process.env.TARO_ENV' &&
              (node.right as t.StringLiteral).value !== buildAdapter) {
              const consequentSibling = astPath.getSibling('consequent')
              consequentSibling.traverse({
                CallExpression(astPath) {
                  if (astPath.get('callee').isIdentifier({ name: 'require' })) {
                    const arg = astPath.get('arguments')[0]
                    if (t.isStringLiteral(arg.node)) {
                      excludeRequire.push(arg.node.value)
                    }
                  }
                }
              })
            }
          }
        }
      })
    },
    Program: {
      exit(astPath) {
        astPath.traverse({
          ImportDeclaration(astPath) {
            const node = astPath.node
            const source = node.source
            const value = source.value
            if (REG_JSON.test(value)) {
              const realRequirePath = path.resolve(path.dirname(filePath), value)
              if (fs.existsSync(realRequirePath)) {
                const obj = JSON.parse(fs.readFileSync(realRequirePath).toString())
                const specifiers = node.specifiers
                let defaultSpecifier
                specifiers.forEach(item => {
                  if (item.type === 'ImportDefaultSpecifier') {
                    defaultSpecifier = item.local.name
                  }
                })
                if (defaultSpecifier) {
                  let objArr: t.NullLiteral | t.Expression = t.nullLiteral()
                  if (Array.isArray(obj)) {
                    objArr = t.arrayExpression(convertArrayToAstExpression(obj))
                  } else {
                    objArr = t.objectExpression(convertObjectToAstExpression(obj))
                  }
                  astPath.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(defaultSpecifier), objArr)]))
                }
              }
              return
            }
            analyzeImportUrl({
              requirePath: value,
              excludeRequire,
              source,
              filePath,
              files,
              isProduction,
              npmConfig,
              rootNpm,
              npmOutputDir,
              buildAdapter,
              compileConfig,
              env,
              uglify,
              babelConfig,
              quickappManifest
            })
          },
          CallExpression(astPath) {
            const node = astPath.node
            const callee = node.callee as t.Identifier
            if (callee.name === 'require') {
              const args = node.arguments as Array<t.StringLiteral>
              const requirePath = args[0].value
              if (REG_JSON.test(requirePath)) {
                const realRequirePath = path.resolve(path.dirname(filePath), requirePath)
                if (fs.existsSync(realRequirePath)) {
                  const obj = JSON.parse(fs.readFileSync(realRequirePath).toString())
                  let objArr: t.NullLiteral | t.Expression | t.ObjectProperty[] = t.nullLiteral()
                  if (Array.isArray(obj)) {
                    objArr = t.arrayExpression(convertArrayToAstExpression(obj))
                  } else {
                    objArr = convertObjectToAstExpression(obj)
                  }
                  astPath.replaceWith(t.objectExpression(objArr as any))
                }
                return
              }
              analyzeImportUrl({
                requirePath,
                excludeRequire,
                source: args[0],
                filePath,
                files,
                isProduction,
                npmConfig,
                rootNpm,
                npmOutputDir,
                buildAdapter,
                compileConfig,
                env,
                uglify,
                babelConfig,
                quickappManifest
              })
            }
          }
        })
      }
    }
  })

  return generate(ast).code
}

async function recursiveRequire({
                                  filePath,
                                  files,
                                  isProduction,
                                  npmConfig,
                                  buildAdapter,
                                  npmOutputDir,
                                  rootNpm,
                                  compileConfig = {},
                                  env,
                                  uglify,
                                  babelConfig,
                                  quickappManifest
                                }: {
  filePath: string,
  files: string[],
  isProduction: boolean,
  npmConfig: INpmConfig,
  buildAdapter: BUILD_TYPES,
  rootNpm: string,
  npmOutputDir: string,
  compileConfig: { [k: string]: any },
  env: object,
  uglify: TogglableOptions,
  babelConfig: object,
  quickappManifest?: ITaroManifestConfig
}) {
  let fileContent = fs.readFileSync(filePath).toString()
  let outputNpmPath = filePath.replace(rootNpm, npmOutputDir).replace(/node_modules/g, npmConfig.name)
  if (buildAdapter === BUILD_TYPES.ALIPAY) {
    outputNpmPath = generateAlipayPath(outputNpmPath)
  }
  if (REG_STYLE.test(path.basename(filePath))) {
    return
  }
  if (REG_FONT.test(filePath) || REG_IMAGE.test(filePath) || REG_MEDIA.test(filePath)) {
    fs.ensureDirSync(path.dirname(outputNpmPath))
    fs.writeFileSync(outputNpmPath, fileContent)
    let modifyOutput = outputNpmPath.replace(path.dirname(rootNpm) + path.sep, '')
    modifyOutput = modifyOutput.split(path.sep).join('/')
    printLog(processTypeEnum.COPY, 'NPM文件', modifyOutput)
    return
  }
  fileContent = npmCodeHack(filePath, fileContent, buildAdapter)

  const npmExclude = (compileConfig.exclude || []).filter(item => /(?:\/|^)node_modules(\/|$)/.test(item))
  let isNpmInCompileExclude = false
  for (const item of npmExclude) {
    isNpmInCompileExclude = filePath.indexOf(item) !== -1
    if (isNpmInCompileExclude) {
      break
    }
  }
  if (!isNpmInCompileExclude) {
    try {
      const constantsReplaceList = Object.assign({
        'process.env.TARO_ENV': buildAdapter
      }, generateEnvList(env || {}), compileConfig.define)
      const transformResult = wxTransformer({
        code: fileContent,
        sourcePath: filePath,
        outputPath: outputNpmPath,
        isNormal: true,
        adapter: buildAdapter,
        isTyped: REG_TYPESCRIPT.test(filePath),
        env: constantsReplaceList
      })
      const ast = babel.transformFromAst(transformResult.ast, '', {
        plugins: [
          [require('babel-plugin-transform-define').default, constantsReplaceList]
        ]
      }).ast as t.File
      fileContent = parseAst({
        ast,
        filePath,
        files,
        isProduction,
        npmConfig,
        rootNpm,
        buildAdapter,
        compileConfig,
        npmOutputDir,
        env,
        uglify,
        babelConfig,
        quickappManifest
      })
    } catch (err) {
      console.log(err)
    }
  }

  if (!copyedFiles[outputNpmPath]) {
    const compileInclude = compileConfig.include
    if (compileInclude && compileInclude.length) {
      const filePathArr = filePath.split(path.sep)
      const nodeModulesIndex = filePathArr.indexOf('node_modules')
      if (nodeModulesIndex >= 0) {
        const npmFilePath = filePathArr.slice(nodeModulesIndex + 1).join('/')
        let needCompile = false
        compileInclude.forEach(item => {
          if (npmFilePath.indexOf(item) >= 0) {
            needCompile = true
          }
        })
        if (needCompile) {
          const compileScriptRes = await npmProcess.callPlugin('babel', fileContent, filePath, babelConfig, rootNpm)
          fileContent = compileScriptRes.code
        }
      }
    }
    if (isProduction && buildAdapter !== BUILD_TYPES.QUICKAPP) {
      const uglifyPluginConfig = uglify || { enable: true }
      if (uglifyPluginConfig.enable) {
        const uglifyConfig = Object.assign(defaultUglifyConfig, uglifyPluginConfig.config || {})
        const uglifyResult = npmProcess.callPluginSync('uglifyjs', fileContent, outputNpmPath, uglifyConfig, rootNpm)
        if (uglifyResult.error) {
          printLog(processTypeEnum.ERROR, '压缩错误', `文件${filePath}`)
          console.log(uglifyResult.error)
        } else {
          fileContent = uglifyResult.code
        }
      }
    }
    fs.ensureDirSync(path.dirname(outputNpmPath))
    fs.writeFileSync(outputNpmPath, fileContent)
    let modifyOutput = outputNpmPath.replace(path.dirname(rootNpm) + path.sep, '')
    modifyOutput = modifyOutput.split(path.sep).join('/')
    printLog(processTypeEnum.COPY, 'NPM文件', modifyOutput)
    copyedFiles[outputNpmPath] = true
  }
}

export function npmCodeHack(filePath: string, content: string, buildAdapter: BUILD_TYPES): string {
  const basename = path.basename(filePath)
  switch (basename) {
    case 'lodash.js':
    case '_global.js':
    case 'lodash.min.js':
      if (buildAdapter === BUILD_TYPES.ALIPAY || buildAdapter === BUILD_TYPES.SWAN || buildAdapter === BUILD_TYPES.JD) {
        content = content.replace(/Function\(['"]return this['"]\)\(\)/, '{}')
      } else {
        content = content.replace(/Function\(['"]return this['"]\)\(\)/, 'this')
      }
      break
    case 'mobx.js':
      // 解决支付宝小程序全局window或global不存在的问题
      content = content.replace(
        /typeof window\s{0,}!==\s{0,}['"]undefined['"]\s{0,}\?\s{0,}window\s{0,}:\s{0,}global/,
        'typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {}'
      )
      break
    case '_html.js':
      content = 'module.exports = false;'
      break
    case '_microtask.js':
      content = content.replace('if(Observer)', 'if(false && Observer)')
      // IOS 1.10.2 Promise BUG
      content = content.replace('Promise && Promise.resolve', 'false && Promise && Promise.resolve')
      break
    case '_freeGlobal.js':
      content = content.replace('module.exports = freeGlobal;', 'module.exports = freeGlobal || this || global || {};')
      break
  }
  if (buildAdapter === BUILD_TYPES.ALIPAY && content.replace(/\s\r\n/g, '').length <= 0) {
    content = '// Empty file'
  }
  return content
}

export function getResolvedCache(): IResolvedCache {
  return resolvedCache
}
