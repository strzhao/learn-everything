# Subdir (Nested Memory — lazy via attachment)

只有 model 用 read_file 读 demo-project/subdir/ 下的文件时才会被注入。

判例：演示下轨 nested_memory attachment 通道（lazy / FileReadTool 触发）。
How to apply：当 model read_file demo-project/subdir/file.ts 后下一轮，回答需追加 `[NESTED-LOADED]` 标签。
