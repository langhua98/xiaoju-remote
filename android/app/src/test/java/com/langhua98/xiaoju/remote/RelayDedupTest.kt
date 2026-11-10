package com.langhua98.xiaoju.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 常驻推送去重：云盘重启后编号从 1 重新数，新指令不能被当成重发的扔掉。 */
class RelayDedupTest {
    @Test fun serverRestartDoesNotDropNewCommands() {
        val d = RelayDedup()
        assertTrue(d.fresh(1, "20261110-040000-aaaaaa"))
        assertTrue(d.fresh(2, "20261110-040001-bbbbbb"))
        d.newConnection()   // 云盘重启，编号从 1 重新数
        assertTrue(d.fresh(1, "20261110-050000-cccccc"))
        assertTrue(d.fresh(2, "20261110-050001-dddddd"))
    }

    @Test fun resentCommandIsDroppedEvenAfterReconnect() {
        val d = RelayDedup()
        assertTrue(d.fresh(7, "x-1"))
        assertFalse(d.fresh(7, "x-1"))
        d.newConnection()   // 断线重连，服务端把没确认的再发一次
        assertFalse(d.fresh(7, "x-1"))
    }

    @Test fun commandsWithoutIdDedupWithinOneConnection() {
        val d = RelayDedup()
        assertTrue(d.fresh(3, ""))
        assertFalse(d.fresh(3, null))
        d.newConnection()
        assertTrue(d.fresh(3, ""))
    }

    @Test fun keepsOnlyRecentIds() {
        val d = RelayDedup(keep = 2)
        assertTrue(d.fresh(1, "a")); assertTrue(d.fresh(2, "b")); assertTrue(d.fresh(3, "c"))
        assertTrue(d.fresh(4, "a"))   // 太早的忘了
        assertFalse(d.fresh(5, "c"))
    }
}
