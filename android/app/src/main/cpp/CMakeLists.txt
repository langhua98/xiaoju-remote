# C++ 部分：
#   xjmotion：超低功耗移动侦测引擎（motion/，不依赖别的库，MotionNative.kt 用）；
#   xjbench：模型测速和物体识别（以后做「认出是不是人」也在这里），ncnn 是腾讯开源的手机端推理库（BSD 协议）。
# ncnn 自己先编好放在 NCNN_DIR（见 scripts/build-ncnn-android.sh），这里只链接它。
cmake_minimum_required(VERSION 3.10)
project(xjbench CXX)

# 移动侦测：-O2，32 位 ARM 上开 NEON（编译器自己向量化），去掉调试符号
add_library(xjmotion SHARED motion/motion_engine.cpp motion/motion_jni.cpp)
target_include_directories(xjmotion PRIVATE motion)
target_compile_options(xjmotion PRIVATE -O2)
set_target_properties(xjmotion PROPERTIES LINK_FLAGS "-s")

set(ncnn_DIR ${NCNN_DIR}/lib/cmake/ncnn)
find_package(ncnn REQUIRED)

add_library(xjbench SHARED bench.cpp fastestdet.cpp detector_jni.cpp)
target_link_libraries(xjbench ncnn log)
# 去掉调试符号，安装包小一点
set_target_properties(xjbench PROPERTIES LINK_FLAGS "-s")
