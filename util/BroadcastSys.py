from typing import Dict, Set, Any
from util.BroadcastMessage import BroadcastMessage
import asyncio
import re


class BroadcastSys:
    def __init__(self, recorder):
        self.subscriptions: Dict[str, Set[Any]] = {"all": set()}
        self.recorder = recorder
        self.debug = True  # 调试模式开关
        self.event_listeners = []
        self.delivery_policy = None

    def add_event_listener(self, listener):
        self.event_listeners.append(listener)

    def _notify_event_listeners(self, log_data):
        for listener in self.event_listeners:
            listener(log_data)

    def set_delivery_policy(self, policy):
        self.delivery_policy = policy

    def _delivery_allowed(self, message, agent, channel):
        if self.delivery_policy is None:
            return True
        return self.delivery_policy(
            source_id=str(getattr(message, "speaker", "") or "unknown"),
            target_id=str(getattr(agent, "name", "") or "unknown"),
            channel=channel,
            message=message,
        )

    @staticmethod
    def _strip_think_blocks(text: str) -> str:
        """去除 <think>...</think> 片段，保持其余内容不变。"""
        try:
            return re.sub(r"(?is)<think>.*?</think>", "", text)
        except Exception:
            return text

    def subscribe(self, subscriber: Any, subscriber_type: str):
        """订阅广播系统"""
        if subscriber_type not in self.subscriptions:
            self.subscriptions[subscriber_type] = set()
        self.subscriptions[subscriber_type].add(subscriber)
        self.subscriptions['all'].add(subscriber)

        if self.debug:
            print(f"[BroadcastSys] 订阅: {getattr(subscriber, 'name', 'unknown')} 类型: {subscriber_type}")

    def unsubscribe(self, subscriber: Any, subscriber_type: str):
        """取消订阅广播系统"""
        if subscriber_type in self.subscriptions:
            self.subscriptions[subscriber_type].discard(subscriber)

        if self.debug:
            print(f"[BroadcastSys] 取消订阅: {getattr(subscriber, 'name', 'unknown')} 类型: {subscriber_type}")

    async def publish(self, subscriber_type: str, message: BroadcastMessage):
        """
        向指定类型订阅者异步发布结构化消息
        ARGS:
            subscriber_type: 订阅者类型 (如 "student")
            message: 广播消息实例
        """
        if self.debug:
            print(f"[BroadcastSys.publish] 异步发布消息给 {subscriber_type}")

        # 添加接收者信息到日志
        log_data = message.to_dict()
        # 去除 message.content 中的 <think>...</think>
        if isinstance(log_data.get("content"), str):
            log_data["content"] = self._strip_think_blocks(log_data["content"]).strip()
        log_data["receiver"] = subscriber_type

        # 收集所有的异步任务
        tasks = []
        agents = self.subscriptions.get(subscriber_type, set())

        if self.debug:
            print(f"[DEBUG] 找到 {len(agents)} 个 {subscriber_type} 类型的订阅者")

        delivered_to = []
        blocked_to = []
        for agent in agents:
            if hasattr(agent, "receive_broadcast"):
                name = str(getattr(agent, "name", "unknown"))
                if not self._delivery_allowed(message, agent, subscriber_type):
                    blocked_to.append(name)
                    continue
                # 将每个 agent 的 receive_broadcast 任务添加到列表中
                tasks.append(agent.receive_broadcast(log_data))
                delivered_to.append(name)

                if self.debug:
                    print(f"[DEBUG] 异步消息发送给: {name}")
        log_data["delivered_to"] = delivered_to
        log_data["blocked_to"] = blocked_to

        # 并发执行所有异步任务
        if tasks:
            await asyncio.gather(*tasks)

        # 记录日志，学生表情表现不做记录
        if message.message_type != "expression":
            await self.recorder.log(
                event_type="broadcast",
                details=log_data
            )
            self._notify_event_listeners(log_data)

    def publish_sync(self, subscriber_type: str, message: BroadcastMessage):
        """
        向指定类型订阅者同步发布结构化消息
        ARGS:
            subscriber_type: 订阅者类型 (如 "student")
            message: 广播消息实例
        """
        if self.debug:
            print(f"[BroadcastSys.publish_sync] 同步发布消息给 {subscriber_type}")

        # 添加接收者信息到日志
        log_data = message.to_dict()
        # 去除 message.content 中的 <think>...</think>
        if isinstance(log_data.get("content"), str):
            log_data["content"] = self._strip_think_blocks(log_data["content"]).strip()
        log_data["receiver"] = subscriber_type

        # 同步调用所有订阅者的 receive_broadcast_sync 方法
        agents = self.subscriptions.get(subscriber_type, set())

        if self.debug:
            print(f"[DEBUG] 找到 {len(agents)} 个 {subscriber_type} 类型的订阅者")

        delivered_to = []
        blocked_to = []
        for agent in agents:
            name = getattr(agent, 'name', 'unknown')
            if self.debug:
                print(f"[DEBUG] 检查订阅者: {name} - 类型: {type(agent).__name__}")

            if not self._delivery_allowed(message, agent, subscriber_type):
                blocked_to.append(str(name))
                continue
            if hasattr(agent, "receive_broadcast_sync"):
                agent.receive_broadcast_sync(log_data)
                delivered_to.append(str(name))

                if self.debug:
                    print(f"[DEBUG] 同步消息已发送给: {name}")
            elif self.debug:
                print(f"[DEBUG] 订阅者没有 receive_broadcast_sync 方法: {name}")

        log_data["delivered_to"] = delivered_to
        log_data["blocked_to"] = blocked_to

        # 记录日志，学生表情表现不做记录
        if message.active_event != "expression":
            self.recorder.log_sync(
                event_type="broadcast",
                details=log_data
            )
            self._notify_event_listeners(log_data)

    def enable_debug(self, debug=True):
        """启用或禁用调试输出"""
        self.debug = debug