// 给 Kotlin（MotionNative.kt）用的移动侦测引擎。
// 画面不复制：用 GetPrimitiveArrayCritical 直接读相机回调给的那块 NV21 缓冲区（Dalvik / ART 上都是原地的指针），
// 只读前面的 Y 平面，读完马上放开（中间不调别的 JNI，大约几十微秒）。也不往 Java 返回新数组：
// analyze 的结果打包成一个 int，统计写进 Kotlin 预先给的 long 数组。
#include <jni.h>

#include "motion_engine.h"

namespace {
inline xjm::MotionEngine* E(jlong h) { return reinterpret_cast<xjm::MotionEngine*>(h); }
}

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeCreate(JNIEnv*, jclass, jint cols, jint rows) {
    return reinterpret_cast<jlong>(new xjm::MotionEngine(cols, rows));
}

JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeFree(JNIEnv*, jclass, jlong h) {
    delete E(h);
}

JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeConfig(JNIEnv*, jclass, jlong h, jint sensitivity, jint standbyMs,
                                                           jint suspectMs, jint activeMs, jint confirm, jint cooldownMs) {
    xjm::Config c;
    c.sensitivity = sensitivity; c.standbyMs = standbyMs; c.suspectMs = suspectMs;
    c.activeMs = activeMs; c.confirm = confirm; c.cooldownMs = cooldownMs;
    E(h)->configure(c);
}

// mask：cols*rows 个字节，非 0 = 检测这一格；null = 整个画面
JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeSetMask(JNIEnv* env, jclass, jlong h, jbyteArray jmask) {
    if (jmask == nullptr) { E(h)->setMask(nullptr); return; }
    jbyte* m = env->GetByteArrayElements(jmask, nullptr);   // 只在改区域时调，复制一下没关系
    E(h)->setMask(reinterpret_cast<const uint8_t*>(m));
    env->ReleaseByteArrayElements(jmask, m, JNI_ABORT);
}

JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeReset(JNIEnv*, jclass, jlong h) { E(h)->reset(); }

JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativePause(JNIEnv*, jclass, jlong h) { E(h)->pause(); }

// 返回：低 8 位是 Flags，8～11 位是阶段，16 位往上是下一帧过多久看（毫秒）
JNIEXPORT jint JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeAnalyze(JNIEnv* env, jclass, jlong h, jbyteArray jnv21,
                                                            jint w, jint ht, jlong now, jboolean recording) {
    xjm::MotionEngine* e = E(h);
    if (env->GetArrayLength(jnv21) < w * ht) return e->stage() << 8 | e->nextMs() << 16;
    void* p = env->GetPrimitiveArrayCritical(jnv21, nullptr);
    if (p == nullptr) return e->stage() << 8 | e->nextMs() << 16;
    int f = e->analyze(static_cast<const uint8_t*>(p), w, ht, w, now, recording == JNI_TRUE);
    env->ReleasePrimitiveArrayCritical(jnv21, p, JNI_ABORT);   // 只读，不写回
    return (f & 0xff) | (e->stage() & 0xf) << 8 | (e->nextMs() & 0x7fff) << 16;
}

JNIEXPORT jboolean JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeMoved(JNIEnv*, jclass, jlong h, jfloat x1, jfloat y1, jfloat x2, jfloat y2) {
    return E(h)->moved(x1, y1, x2, y2) ? JNI_TRUE : JNI_FALSE;
}

// out（至少 11 个）：看了几帧、读了多少像素、疑似、过滤掉、确认、背景重来、变化占比 ×1e6、噪点 ×1000、疑似里看到几帧、背景学好没、相机该给几帧/秒
JNIEXPORT void JNICALL
Java_com_langhua98_xiaoju_remote_MotionNative_nativeStats(JNIEnv* env, jclass, jlong h, jlongArray jout) {
    xjm::MotionEngine* e = E(h);
    xjm::Stats s = e->stats();
    jlong v[11] = {s.analyzed, s.samples, s.suspects, s.aborted, s.confirms, s.rebases,
                   (jlong)(s.score * 1e6f), (jlong)(s.noise * 1000.0f), s.hits, e->ready() ? 1 : 0, e->cameraFps()};
    jsize n = env->GetArrayLength(jout);
    env->SetLongArrayRegion(jout, 0, n < 11 ? n : 11, v);
}

}  // extern "C"
