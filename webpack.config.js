const path = require("path");
const webpack = require("webpack");

module.exports = {
  target: "web",
  entry: {
    "amp-http-helper-frame": path.resolve(
      path.join(__dirname, "./src/amp-helper-frame-entry.ts")
    ),
    "amp-http-remote-frame": path.resolve(
      path.join(__dirname, "./src/amp-remote-frame-entry.ts")
    )
  },
  output: {
    path: path.resolve(path.join(__dirname, "./dist")),
    filename: "[name].js"
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: path.resolve(path.join(__dirname, "./src")),
        exclude: /(node_modules|bower_components)/,
        use: "ts-loader"
      }
    ]
  },
  resolve: {
    extensions: [".js", ".ts"],
    modules: [
      path.resolve(path.join(__dirname, "./dist")),
      path.resolve(path.join(__dirname, "./node_modules"))
    ]
  },
  devtool: "source-map",
  plugins: [
    new webpack.optimize.ModuleConcatenationPlugin(),
    new webpack.optimize.UglifyJsPlugin({
      sourceMap: true,
      compress: {
        sequences: true,
        properties: true,
        dead_code: true,
        conditionals: true,
        comparisons: true,
        evaluate: true,
        booleans: true,
        loops: true,
        unused: true,
        hoist_funs: true,
        if_return: true,
        join_vars: true,
        cascade: true,
        collapse_vars: true,
        drop_console: false,
        drop_debugger: false,
        warnings: false,
        negate_iife: true
      },
      mangle: {
        enable: true,
        except: []
      },
      output: {
        comments: false
      }
    })
  ]
};
