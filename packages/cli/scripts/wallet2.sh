#!/bin/bash

command="yarn cli mint -w $1 -i 45ee725c2c5993b3e4d308842d87e973bf1951f5f7a804b21e4dd964ecd12d6b_0 5 2000"

while true; do
    $command

    if [ $? -ne 0 ]; then
        echo "命令执行失败，退出循环"
        exit 1
    fi

    sleep 1
done
