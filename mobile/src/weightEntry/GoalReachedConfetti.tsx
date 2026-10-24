/** @file Goal Reached Confetti: Animates a bounded goal celebration only while active and when reduced motion permits it. */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAppTheme } from '../theme';

type GoalReachedConfettiProps = {
    active: boolean;
    reduceMotion: boolean;
};

const CONFETTI_DURATION_MS = 850; // Brief one-shot recognition without delaying the user's next action.
const CONFETTI_PARTICLE_COUNT = 24;

/** Animates a bounded goal celebration only while active and when reduced motion permits it. */
export const GoalReachedConfetti: React.FC<GoalReachedConfettiProps> = ({ active, reduceMotion }) => {
    const theme = useAppTheme();
    const progress = useRef(new Animated.Value(0)).current;
    const particles = useMemo(() => Array.from({ length: CONFETTI_PARTICLE_COUNT }, (_, index) => ({
        key: index,
        left: 4 + ((index * 37) % 92),
        drift: ((index % 7) - 3) * 8,
        delay: (index % 6) * 0.04,
        color: [theme.colors.primary, theme.colors.warningAccent, theme.colors.info, theme.colors.success][index % 4],
        rotate: 90 + ((index * 53) % 240)
    })), [theme.colors.info, theme.colors.primary, theme.colors.success, theme.colors.warningAccent]);

    useEffect(() => {
        if (!active || reduceMotion) return;
        progress.setValue(0);
        const animation = Animated.timing(progress, {
            toValue: 1,
            duration: CONFETTI_DURATION_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true
        });
        animation.start();
        return () => animation.stop();
    }, [active, progress, reduceMotion]);

    if (!active) return null;
    if (reduceMotion) {
        return (
            <View
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                pointerEvents="none"
                style={styles.staticCelebration}
                testID="goal-celebration-static"
            >
                <Ionicons name="sparkles" size={44} color={theme.colors.warningAccent} />
            </View>
        );
    }

    return (
        <View
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={styles.overlay}
            testID="goal-confetti"
        >
            {particles.map((particle) => {
                const start = particle.delay;
                const fallProgress = progress.interpolate({
                    inputRange: [start, 1],
                    outputRange: [0, 1],
                    extrapolate: 'clamp'
                });
                return (
                    <Animated.View
                        key={particle.key}
                        style={[
                            styles.particle,
                            {
                                left: `${particle.left}%`,
                                backgroundColor: particle.color,
                                opacity: fallProgress.interpolate({
                                    inputRange: [0, 0.08, 0.82, 1],
                                    outputRange: [0, 1, 1, 0]
                                }),
                                transform: [
                                    {
                                        translateY: fallProgress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [-16, 176]
                                        })
                                    },
                                    {
                                        translateX: fallProgress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0, particle.drift]
                                        })
                                    },
                                    {
                                        rotate: fallProgress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: ['0deg', `${particle.rotate}deg`]
                                        })
                                    }
                                ]
                            }
                        ]}
                    />
                );
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    overlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        height: 192,
        overflow: 'hidden',
        zIndex: 2
    },
    particle: {
        position: 'absolute',
        top: 0,
        width: 8,
        height: 14,
        borderRadius: 2
    },
    staticCelebration: {
        position: 'absolute',
        top: 12,
        right: 12,
        opacity: 0.7,
        zIndex: 2
    }
});
