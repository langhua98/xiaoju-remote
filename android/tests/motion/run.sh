#!/bin/sh
# 在电脑上测 C++ 移动侦测引擎：sh run.sh [结果表.tsv]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
CPP="$HERE/../../app/src/main/cpp/motion"
OUT=${WORK:-/tmp/xj-motion-test}
mkdir -p "$OUT"
${CXX:-c++} -std=c++11 -O2 -Wall -I"$CPP" "$HERE/test_motion.cpp" "$CPP/motion_engine.cpp" -o "$OUT/test_motion" -lpthread
"$OUT/test_motion" "$@"
# 电脑版 libxjmotion.so（给 Kotlin 单元测试 MotionNativeTest 用：XJ_NATIVE_LIB=$OUT/lib）
JH=${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}
if [ -f "$JH/include/jni.h" ]; then
  mkdir -p "$OUT/lib"
  ${CXX:-c++} -std=c++11 -O2 -Wall -shared -fPIC -I"$CPP" -I"$JH/include" -I"$JH/include/linux" \
    "$CPP/motion_engine.cpp" "$CPP/motion_jni.cpp" -o "$OUT/lib/libxjmotion.so" -lpthread
  echo "电脑版 C++ 侦测库：$OUT/lib/libxjmotion.so"
fi
