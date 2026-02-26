#!/bin/bash

# VAEB Docker Deployment Script
# Verified Agent Execution Bundle - Quick Start

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "${PROJECT_ROOT}"

# Functions
print_status() {
    echo -e "${BLUE}[VAEB]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

# Check if .env exists
check_env() {
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        print_error ".env file not found!"
        print_status "Please copy .env.example to .env and configure your settings:"
        echo "  cp .env.example .env"
        exit 1
    fi
    print_success ".env file found"
}

# Check Docker and Docker Compose
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed!"
        exit 1
    fi
    print_success "Docker is installed"

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_error "Docker Compose is not installed!"
        exit 1
    fi
    print_success "Docker Compose is installed"
}

# Build all services
build_services() {
    print_status "Building VAEB services..."
    cd "$PROJECT_ROOT"

    if docker compose build; then
        print_success "All services built successfully"
    else
        print_error "Build failed!"
        exit 1
    fi
}

# Start all services
start_services() {
    print_status "Starting VAEB services..."
    cd "$PROJECT_ROOT"

    if docker compose up -d; then
        print_success "All services started"
    else
        print_error "Failed to start services!"
        exit 1
    fi
}

# Stop all services
stop_services() {
    print_status "Stopping VAEB services..."
    cd "$PROJECT_ROOT"
    docker compose down
    print_success "All services stopped"
}

# Show logs
show_logs() {
    cd "$PROJECT_ROOT"
    docker compose logs -f "$@"
}

# Show status
show_status() {
    cd "$PROJECT_ROOT"
    echo ""
    print_status "Service Status:"
    docker compose ps
    echo ""
    print_status "Service URLs:"
    echo "  Frontend:     http://localhost:13080"
    echo "  Server API:   http://localhost:13002"
    echo "  Prover Svc:   http://localhost:13001"
}

# Main menu
show_menu() {
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║     VAEB Docker Deployment Tool       ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  build       Build all Docker images"
    echo "  start       Start all services"
    echo "  stop        Stop all services"
    echo "  restart     Restart all services"
    echo "  logs        Show service logs"
    echo "  status      Show service status"
    echo "  setup       Initial setup (check env, docker)"
    echo "  clean       Stop and remove all containers and volumes"
    echo ""
}

# Command handling
case "${1:-}" in
    build)
        check_env
        check_docker
        build_services
        ;;
    start)
        check_env
        check_docker
        start_services
        show_status
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        sleep 2
        start_services
        show_status
        ;;
    logs)
        shift
        show_logs "$@"
        ;;
    status)
        show_status
        ;;
    setup)
        check_env
        check_docker
        print_success "Setup complete! Ready to build and deploy."
        ;;
    clean)
        print_warning "This will remove all containers, networks, and volumes!"
        read -p "Are you sure? (y/N): " confirm
        if [[ $confirm =~ ^[Yy]$ ]]; then
            cd "$PROJECT_ROOT"
            docker compose down -v --rmi all
            print_success "Cleanup complete"
        fi
        ;;
    *)
        show_menu
        exit 0
        ;;
esac
