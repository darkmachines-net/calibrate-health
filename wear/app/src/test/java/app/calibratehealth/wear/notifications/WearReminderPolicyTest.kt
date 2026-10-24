/** Regression tests and fixtures for Wear Reminder Policy. */

package app.calibratehealth.wear.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearReminderPolicyTest {
    private val reminders = listOf(
        WearReminder(11, WearReminderType.FOOD, "2026-07-12", 100),
        WearReminder(12, WearReminderType.WEIGHT, "2026-07-12", 101)
    )

    /** Verifies that reachable phone cancels local reminder to avoid mirrored duplicates. */
    @Test
    fun `reachable phone cancels local reminder to avoid mirrored duplicates`() {
        assertEquals(
            WearReminderDecision.Cancel,
            WearReminderPolicy.decide(reminders, true, true, null)
        )
    }

    /** Verifies that disconnected watch combines current reminders into one deep link. */
    @Test
    fun `disconnected watch combines current reminders into one deep link`() {
        val decision = WearReminderPolicy.decide(reminders, false, true, null)
        assertTrue(decision is WearReminderDecision.Notify)
        val notification = (decision as WearReminderDecision.Notify).notification
        assertEquals(setOf(WearReminderType.FOOD, WearReminderType.WEIGHT), notification.types)
        assertEquals(WearReminderNotification.DESTINATION_FOOD, notification.destination)
        assertEquals("2026-07-12", notification.localDate)
    }

    /** Verifies that permission and persisted fingerprint suppress conflicting repeats. */
    @Test
    fun `permission and persisted fingerprint suppress conflicting repeats`() {
        assertEquals(
            WearReminderDecision.None,
            WearReminderPolicy.decide(reminders, false, false, null)
        )
        val first = WearReminderPolicy.decide(reminders, false, true, null) as WearReminderDecision.Notify
        assertEquals(
            WearReminderDecision.None,
            WearReminderPolicy.decide(reminders, false, true, first.notification.fingerprint)
        )
        assertEquals(WearReminderDecision.Cancel, WearReminderPolicy.decide(emptyList(), false, true, null))
    }
}
