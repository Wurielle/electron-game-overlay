echo "copy dlls to node-addon dir"
copy /y .\libs\native-game-overlay\prebuilt\n_overlay.dll .\libs\node-game-overlay
copy /y .\libs\native-game-overlay\prebuilt\n_overlay.x64.dll .\libs\node-game-overlay
copy /y .\libs\native-game-overlay\prebuilt\injector_helper.exe .\libs\node-game-overlay
copy /y .\libs\native-game-overlay\prebuilt\injector_helper.x64.exe .\libs\node-game-overlay
