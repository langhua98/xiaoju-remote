package com.langhua98.xiaoju.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupScheduleTest {
    private var t = 1_000_000L
    private val s = BackupSchedule { t }

    @Test fun firstTimeIsDue() = assertTrue(s.due())

    @Test fun waitsAMinuteAfterEachUpload() {
        s.done()
        assertFalse(s.due())
        t += BackupSchedule.GAP_MS - 1; assertFalse(s.due())
        t += 1; assertTrue(s.due())
    }

    @Test fun retriesFiveMinutesAfterError() {
        s.failed()
        t += BackupSchedule.RETRY_MS - 1; assertFalse(s.due())
        t += 1; assertTrue(s.due())
    }

    @Test fun cloudBackRetriesAtOnce() {
        s.failed()
        assertTrue(s.cloudBack())
        assertTrue(s.due())
        assertFalse(s.failing)
    }

    @Test fun cloudBackDoesNotSkipTheGap() {
        s.done()
        assertFalse(s.cloudBack())   // 没出错：照样歇够 1 分钟，不抢网速
        assertFalse(s.due())
    }
}
