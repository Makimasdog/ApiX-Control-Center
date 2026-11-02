import asyncio, json, sys
from pathlib import Path
from openjudge.graders.function_grader import FunctionGrader
from openjudge.graders.schema import GraderScore, GraderError
from openjudge.runner.grading_runner import GradingRunner

source = Path(sys.argv[1])
report = json.loads(source.read_text(encoding='utf-8'))

def outcome(record):
    passed = record.get('runtimeVerified') is True and record.get('independentTaskSuccess') is True
    return GraderScore(name='task_outcome', score=float(passed), reason='runtimeVerified=%s; independentTaskSuccess=%s' % (record.get('runtimeVerified'), record.get('independentTaskSuccess')), metadata={'taskId': record['taskId'], 'runType': record.get('runType')})

def evidence(record):
    checks = record.get('finalAttempt', {}).get('independent', {})
    passed = checks.get('passed') is True and record.get('finalAttempt', {}).get('tracePassed') is True
    return GraderScore(name='frozen_evidence', score=float(passed), reason='frozen judge passed=%s; required trace passed=%s' % (checks.get('passed'), record.get('finalAttempt', {}).get('tracePassed')), metadata={'taskId': record['taskId']})

async def main():
    configs = {name: {'grader': FunctionGrader(func=fn, name=name), 'mapper': lambda item: {'record': item}} for name, fn in [('task_outcome', outcome), ('frozen_evidence', evidence)]}
    rows = report['results']
    runner = GradingRunner(grader_configs=configs, max_concurrency=1)
    result = await runner.arun(rows)
    serialized = {key: [r.model_dump() for r in values] for key, values in result.items()}
    assert len(result['task_outcome']) == 5
    assert all(not isinstance(r, GraderError) and r.score == 1 for values in result.values() for r in values)
    negative = dict(rows[0], independentTaskSuccess=False)
    control = await configs['task_outcome']['grader'].aevaluate(record=negative)
    assert control.score == 0
    output = {'schemaVersion': 1, 'purpose': 'OpenJudge read-only integration feasibility, not model capability evaluation', 'upstreamCommit': '070f7b8f2a3144f50788a9161c509c24130fb502', 'apixHead': report['repositoryHead'], 'node': report['node'], 'mode': report['mode'], 'sourceReportSha256': __import__('hashlib').sha256(source.read_bytes()).hexdigest(), 'counts': report['counts'], 'modelRequests': report['requests'], 'graderResults': serialized, 'syntheticNegativeControl': control.model_dump(), 'limitations': ['FunctionGrader consumes existing runtime judgments; does not independently rerun code', 'No LLM judge, real-provider tasks, full OpenJudge installation or DistributionAnalyzer verified']}
    Path(sys.argv[2]).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'openjudgeScores': sum(len(v) for v in result.values()), 'passedTasks': 5, 'syntheticNegativeRejected': control.score == 0, 'output': sys.argv[2]}))
asyncio.run(main())
