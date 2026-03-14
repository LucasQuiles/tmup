export declare const toolDefinitions: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            project_dir: {
                type: string;
                description: string;
            };
            session_name: {
                type: string;
                description: string;
            };
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            verbose: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            subject: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
            role: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                description: string;
            };
            max_retries: {
                type: string;
                description: string;
            };
            deps: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            requires: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            produces: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            tasks: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        subject: {
                            type: string;
                        };
                        description: {
                            type: string;
                        };
                        role: {
                            type: string;
                        };
                        priority: {
                            type: string;
                        };
                        max_retries: {
                            type: string;
                        };
                        deps: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                        requires: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                        produces: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                    };
                    required: string[];
                };
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            status: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                description: string;
            };
            role: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
            max_retries: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            agent_id: {
                type: string;
                description: string;
            };
            role: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            result_summary: {
                type: string;
                description: string;
            };
            artifacts: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                        };
                        path: {
                            type: string;
                        };
                    };
                    required: string[];
                };
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            reason: {
                type: string;
                enum: string[];
                description: string;
            };
            message: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            cascade: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            message: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            to: {
                type: string;
                description: string;
            };
            type: {
                type: string;
                enum: string[];
                description: string;
            };
            payload: {
                type: string;
                description: string;
            };
            task_id: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            agent_id: {
                type: string;
                description: string;
            };
            mark_read: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            role: {
                type: string;
                description: string;
            };
            pane_index: {
                type: string;
                description: string;
            };
            working_dir: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            lines?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            pane_index: {
                type: string;
                description: string;
            };
            lines: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            working_dir?: undefined;
            session_id?: undefined;
            force?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            session_id: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            force?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            force: {
                type: string;
                description: string;
            };
            project_dir?: undefined;
            session_name?: undefined;
            verbose?: undefined;
            subject?: undefined;
            description?: undefined;
            role?: undefined;
            priority?: undefined;
            max_retries?: undefined;
            deps?: undefined;
            requires?: undefined;
            produces?: undefined;
            tasks?: undefined;
            task_id?: undefined;
            status?: undefined;
            agent_id?: undefined;
            result_summary?: undefined;
            artifacts?: undefined;
            reason?: undefined;
            message?: undefined;
            cascade?: undefined;
            to?: undefined;
            type?: undefined;
            payload?: undefined;
            mark_read?: undefined;
            pane_index?: undefined;
            working_dir?: undefined;
            lines?: undefined;
            session_id?: undefined;
        };
        required?: undefined;
    };
})[];
export declare function handleToolCall(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
}>;
