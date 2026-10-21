"""Standalone stdio MCP demo, not a database health check or an automated test.

Optional dependency: python -m pip install "mcp==1.30.0"
Start with: python test/MCP_test.py
"""
from mcp.server.fastmcp import FastMCP

# 1. 实例化一个服务
mcp = FastMCP("Database-Helper")

# 2. 注册一个演示资源，不连接真实数据库。
@mcp.resource("config://status")
def get_service_status() -> str:
    """说明本示例的模拟状态，不报告真实数据库健康状态。"""
    return "演示资源：本示例不连接 MySQL 或 Redis，不代表数据库健康检查结果。"

# 3. 注册一个工具 (Tool)
@mcp.tool()
def calculate_growth_rate(current: float, previous: float) -> str:
    """计算业务增长率并返回百分比格式"""
    if previous == 0:
        return "无法计算：基数为0"
    rate = ((current - previous) / previous) * 100
    return f"{rate:.2f}%"

if __name__ == "__main__":
    # 以 stdio 模式启动
    mcp.run(transport="stdio")
