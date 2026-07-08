/**
 * Build config for electron 'Renderer Process' file
 */

const path = require('path');

module.exports = {
    mode: 'production',
    devtool: 'cheap-module-source-map',

    entry: [
        path.join(__dirname, 'src/renderer/main.ts')
    ],

    output: {
        filename: "renderer.js",
        path: path.join(__dirname, "dist/renderer")
    },

    resolve: {
        // Add '.ts' and '.tsx' as resolvable extensions.
        extensions: [".ts", ".tsx", ".js", ".json"]
    },

    module: {
        rules: [
            // All files with a '.ts' or '.tsx' extension will be handled by 'ts-loader'.
            {
                test: /\.tsx?$/,
                loader: "ts-loader",
                options: {
                    configFile: path.join(__dirname, "tsconfig.renderer.json")
                  }
            },

            // All output '.js' files will have any sourcemaps re-processed by 'source-map-loader'.
            {
                enforce: "pre",
                test: /\.js$/,
                loader: "source-map-loader"
            }
        ]
    },

    // When importing a module whose path matches one of the following, just
    // assume a corresponding global variable exists and use that instead.
    // This is important because it allows us to avoid bundling all of our
    // dependencies, which allows browsers to cache those libraries between builds.
    externals: {
        "react": "React",
        "react-dom": "ReactDOM"
    },

    // https://github.com/chentsulin/webpack-target-electron-renderer#how-this-module-works
    target: 'electron-renderer'
};
