export {};

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const modulePath = "../lib/animation-coordinator.ts";
const firstModule = await import(`${modulePath}?owner=first`);
const secondModule = await import(`${modulePath}?owner=second`);

const initial = firstModule.getProcessAnimationDiagnostics();
const firstFrames: number[] = [];
const secondFrames: number[] = [];
const unsubscribeFirst = firstModule.subscribeProcessAnimation((now: number) =>
	firstFrames.push(now),
);
const afterFirst = firstModule.getProcessAnimationDiagnostics();
const unsubscribeSecond = secondModule.subscribeProcessAnimation((now: number) =>
	secondFrames.push(now),
);
const afterSecond = secondModule.getProcessAnimationDiagnostics();

assert(
	"separately loaded modules join one process-wide animation timer",
	initial.subscriptionCount === 0 &&
		afterFirst.subscriptionCount === 1 &&
		afterSecond.subscriptionCount === 2 &&
		afterSecond.timerActive &&
		afterSecond.timerIntervalMs === 150 &&
		afterSecond.timerStarts === afterFirst.timerStarts,
	JSON.stringify({ initial, afterFirst, afterSecond }),
);

await sleep(300);
assert(
	"same-cadence subscribers receive one shared frame timestamp",
	firstFrames.length >= 1 && secondFrames.length >= 1 && firstFrames[0] === secondFrames[0],
	JSON.stringify({ firstFrames, secondFrames }),
);

unsubscribeFirst();
unsubscribeFirst();
const afterOneRemoved = firstModule.getProcessAnimationDiagnostics();
unsubscribeSecond();
const afterAllRemoved = secondModule.getProcessAnimationDiagnostics();
assert(
	"subscriptions clean up idempotently and stop the global timer",
	afterOneRemoved.subscriptionCount === 1 &&
		afterOneRemoved.timerActive &&
		afterAllRemoved.subscriptionCount === 0 &&
		!afterAllRemoved.timerActive,
	JSON.stringify({ afterOneRemoved, afterAllRemoved }),
);

const unsubscribeSlower = firstModule.subscribeProcessAnimation(() => undefined, 360);
const slower = secondModule.getProcessAnimationDiagnostics();
unsubscribeSlower();
assert(
	"off-cadence requests round up to a shared 150ms frame multiple",
	slower.subscriptionCount === 1 && slower.timerIntervalMs === 450,
	JSON.stringify(slower),
);

const unsubscribeBroken = secondModule.subscribeProcessAnimation(() => {
	throw new Error("broken animation subscriber");
});
await sleep(300);
const afterBroken = firstModule.getProcessAnimationDiagnostics();
unsubscribeBroken();
assert(
	"a broken subscriber is isolated and cannot leak the process timer",
	afterBroken.subscriptionCount === 0 && !afterBroken.timerActive,
	JSON.stringify(afterBroken),
);

console.log("All animation-coordinator tests passed.");
